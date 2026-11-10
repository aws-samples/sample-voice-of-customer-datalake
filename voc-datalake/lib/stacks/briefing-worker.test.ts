/**
 * The morning brief's infrastructure (briefing-worker.ts, docs/briefing.md): pay-per-use only,
 * a KMS-encrypted queue + DLQ and topic, at most 2 builds at once, and least-privilege roles
 * on the worker and on the settings API that subscribes a user's own email.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { BRIEFING_MAX_CONCURRENCY } from './briefing-worker';
import { actionsWithPrefix, apiTemplateAllPlugins, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const holder: { processing?: Template; api?: Template } = {};
const processing = (): Template => holder.processing ?? (holder.processing = synthProcessingTemplate());
const api = (): Template => holder.api ?? (holder.api = apiTemplateAllPlugins());

/** Properties of the `type` resources whose rendered name property contains `fragment`. */
function named(type: string, fragment: string): Record<string, unknown>[] {
  return Object.values(processing().findResources(type)).flatMap((resource) => {
    const props: unknown = resource.Properties;
    if (typeof props !== 'object' || props === null) return [];
    const name = JSON.stringify(['QueueName', 'TopicName', 'Name'].map((key) => (key in props ? Reflect.get(props, key) : null)));
    return name.includes(fragment) ? [Object.fromEntries(Object.entries(props))] : [];
  });
}

beforeAll(() => {
  processing();
  api();
}, SYNTH_TIMEOUT_MS);

describe('VocProcessingStack: the brief worker', () => {
  it('builds from the queue one message at a time, at most two at once', () => {
    const mappings = Object.values(processing().findResources('AWS::Lambda::EventSourceMapping', {
      Properties: { EventSourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^BriefingWorkerQueue'), 'Arn'] } },
    }));
    expect(mappings.map((m) => m.Properties)).toStrictEqual([expect.objectContaining({
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: BRIEFING_MAX_CONCURRENCY },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    })]);
  });

  it('encrypts the queue, its DLQ and the topic with a customer-managed key', () => {
    expect(named('AWS::SQS::Queue', 'voc-briefing-dlq').map((p) => 'KmsMasterKeyId' in p)).toStrictEqual([true]);
    const [queue] = named('AWS::SQS::Queue', '"voc-briefing-"');
    expect(queue).toMatchObject({ KmsMasterKeyId: expect.anything(), RedrivePolicy: { maxReceiveCount: 3 } });
    expect(named('AWS::SNS::Topic', 'voc-briefing').map((p) => 'KmsMasterKeyId' in p)).toStrictEqual([true]);
  });

  it('dispatches on a 15-minute schedule and creates no subscription in the template', () => {
    expect(named('AWS::Events::Rule', 'voc-briefing-dispatch').map((p) => p.ScheduleExpression))
      .toStrictEqual(['rate(15 minutes)']);
    expect(Object.keys(processing().findResources('AWS::SNS::Subscription'))).toStrictEqual([]);
  });

  it('reads, never deletes: no Scan, no DeleteItem anywhere on the worker role', () => {
    const actions = actionsWithPrefix(policyStatementsOf(processing(), 'BriefingWorkerBriefingRole'), 'dynamodb:');
    expect(actions).not.toContain('dynamodb:Scan');
    expect(actions).not.toContain('dynamodb:DeleteItem');
    expect(actions).toContain('dynamodb:Query');
  });

  it('re-checks the reader in Cognito and publishes only to the brief topic', () => {
    const statements = policyStatementsOf(processing(), 'BriefingWorkerBriefingRole');
    expect(actionsWithPrefix(statements, 'cognito-idp:')).toStrictEqual(['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser']);
    const publish = statements.filter((s) => s.actions.includes('sns:Publish'));
    expect(publish.map((s) => s.resource)).toStrictEqual([expect.stringContaining('BriefingWorkerTopic')]);
  });

  it('reads voc-radar for the Radar cards, and only reads it (GetItem + Query)', () => {
    const env = serviceEnvironment(processing(), 'voc-briefing');
    expect(JSON.stringify(env.RADAR_TABLE)).toMatch(/Radar/);
    const radar = policyStatementsOf(processing(), 'BriefingWorkerBriefingRole').filter((s) => /Radar/.test(s.resource));
    expect(actionsWithPrefix(radar, 'dynamodb:')).toStrictEqual(['dynamodb:GetItem', 'dynamodb:Query']);
  });
});

describe('VocApiStack: the settings API serves /settings/my-briefing', () => {
  it('names the queue, the topic and the user pool', () => {
    const env = serviceEnvironment(api(), 'voc-settings-api');
    expect(JSON.stringify(env.BRIEFING_QUEUE_URL)).toContain('voc-briefing-');
    expect(JSON.stringify(env.BRIEFING_TOPIC_ARN)).toContain(':sns:');
    expect(env.USER_POOL_ID).toBeDefined();
  });

  it('may subscribe and read subscriptions on the brief topic only, and only read users', () => {
    const statements = policyStatementsOf(api(), 'SettingsLambdaRole');
    const snsStatements = statements.filter((s) => s.actions.some((a) => a.startsWith('sns:')));
    expect(snsStatements.map((s) => [s.actions, s.resource.includes('voc-briefing-')])).toStrictEqual([
      [['sns:Subscribe', 'sns:Unsubscribe', 'sns:GetSubscriptionAttributes'], true],
    ]);
    expect(actionsWithPrefix(statements, 'cognito-idp:')).toStrictEqual(['cognito-idp:AdminGetUser']);
    expect(actionsWithPrefix(statements, 'sns:')).not.toContain('sns:Publish');
  });
});
