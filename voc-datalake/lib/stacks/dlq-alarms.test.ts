/**
 * The operational alarm topic (#247) and the "no alarm until an admin turns
 * alerting on" contract.
 *
 * CDK deploys the encrypted, TLS-only topic and NO alarm or subscription: an
 * alarm is billed every hour it exists, so the logs API creates them at runtime
 * (Settings → Logs → Alerts, lambda/shared/ops_alerts.py). These cases pin that
 * no stack synthesizes an alarm, that the topic still lets alarms publish, and
 * that the logs API is wired with the exact names of every queue and function
 * alerting watches — the same strings the owning stacks synthesize.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { VocCoreStack } from './core-stack';
import {
  ALARM_NAME_PREFIX, ALARM_PUBLISH_SID, ALARM_TOPIC_BASE_NAME, API_ASYNC_FAILURES_QUEUE_BASE_NAME, OPS_ALERT_ALARM_BASE_NAME,
  opsAlertsWiring,
} from './dlq-alarms';
import { apiTemplateAllPlugins, discoverPluginIds, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_ACCOUNT, SYNTH_REGION, committedFeatureFlags } from '../test-support/synth-app';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { itemAt } from '../test-support/guards';
import { byCodeUnit } from '../utils/compare';

const env = { account: SYNTH_ACCOUNT, region: SYNTH_REGION };

const QueueSchema = z.object({ Properties: z.object({ QueueName: z.unknown() }) });
const FunctionSchema = z.object({ Properties: z.object({ FunctionName: z.unknown() }) });

/** The synthesized `QueueName` of the one queue whose logical id starts with `prefix`. */
function queueNameOf(template: Template, prefix: string): unknown {
  const queues = Object.entries(template.findResources('AWS::SQS::Queue'))
    .filter(([logicalId]) => logicalId.startsWith(prefix));
  expect(queues.map(([logicalId]) => logicalId), `expected one ${prefix} queue`).toHaveLength(1);
  return QueueSchema.parse(itemAt(queues, 0)[1]).Properties.QueueName;
}

/** The synthesized `FunctionName` of the one function whose logical id starts with `prefix`. */
function functionNameOf(template: Template, prefix: string): unknown {
  const functions = Object.entries(template.findResources('AWS::Lambda::Function'))
    .filter(([logicalId]) => logicalId.startsWith(prefix));
  expect(functions.map(([logicalId]) => logicalId), `expected one ${prefix} function`).toHaveLength(1);
  return FunctionSchema.parse(itemAt(functions, 0)[1]).Properties.FunctionName;
}

const JoinSchema = z.object({ 'Fn::Join': z.tuple([z.string(), z.array(z.unknown())]) });

/**
 * A synthesized string value with its pseudo-parameter Refs written as
 * `<AWS::AccountId>`: comparable across stacks, whose own Refs are all the same pseudo
 * parameters. Anything else (a resource Ref, GetAtt, import) renders as `<?>`.
 */
function rendered(value: unknown): string {
  if (typeof value === 'string') return value;
  const ref = z.object({ Ref: z.string() }).safeParse(value);
  if (ref.success) return ref.data.Ref.startsWith('AWS::') ? `<${ref.data.Ref}>` : '<?>';
  const join = JoinSchema.safeParse(value);
  if (join.success) return join.data['Fn::Join'][1].map(rendered).join(join.data['Fn::Join'][0]);
  return '<?>';
}

function synthCoreTemplate(context: Record<string, unknown> = {}, deploymentPrefix?: string): Template {
  const app = new cdk.App({
    context: { ...committedFeatureFlags(), 'aws:cdk:bundling-stacks': [], skipFrontendBuildCheck: true, ...context },
  });
  return Template.fromStack(new VocCoreStack(app, 'TestCoreStack', { env, deploymentPrefix }));
}

/** Synthesize once per file: the alarm cases below read the same three stacks. */
function memo<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => {
    value ??= make();
    return value;
  };
}


describe('VocCoreStack alarm topic', () => {
  let template: Template;
  beforeAll(() => {
    template = synthCoreTemplate();
  });

  function topic(): { id: string; props: Record<string, unknown> } {
    const topics = Object.entries(template.findResources('AWS::SNS::Topic'))
      .filter(([logicalId]) => logicalId.startsWith('OpsAlarms'));
    expect(topics, 'expected exactly one alarm topic').toHaveLength(1);
    const [id, resource] = itemAt(topics, 0);
    return { id, props: z.object({ Properties: z.record(z.string(), z.unknown()) }).parse(resource).Properties };
  }

  it('is one topic, named for the stacks that import it', () => {
    expect(JSON.stringify(topic().props.TopicName)).toContain(`${ALARM_TOPIC_BASE_NAME}-`);
  });

  it('is encrypted with its own CMK that CloudWatch may use', () => {
    const { KmsMasterKeyId } = topic().props;
    const keyId = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) }).parse(KmsMasterKeyId)['Fn::GetAtt'][0];
    expect(keyId).toMatch(/^OpsAlarmsKey/);
    const key = z.object({ Properties: z.object({ EnableKeyRotation: z.boolean(), KeyPolicy: z.unknown() }) })
      .parse(template.findResources('AWS::KMS::Key')[keyId]).Properties;
    expect(key.EnableKeyRotation).toBe(true);
    const policy = JSON.stringify(key.KeyPolicy);
    expect(policy).toContain('cloudwatch.amazonaws.com');
    expect(policy).toContain('kms:GenerateDataKey*');
  });

  it('denies non-TLS publishes (enforceSSL)', () => {
    const { id } = topic();
    const policies = Object.values(template.findResources('AWS::SNS::TopicPolicy'))
      .map((resource) => JSON.stringify(resource))
      .filter((serialized) => serialized.includes(id));
    expect(policies).toHaveLength(1);
    expect(itemAt(policies, 0)).toContain('"aws:SecureTransport":"false"');
  });

  it('lets CloudWatch alarms of this account (voc-* names) publish, least privilege (F2)', () => {
    // Without this Allow the enforceSSL policy (which replaces SNS's default
    // access policy) holds only a Deny, and every alarm action fails.
    const { id } = topic();
    expect(publishGrantsOn(template, id)).toStrictEqual([expectedPublishGrant(id, 'voc-')]);
  });

  it('scopes the publish grant to the deployment prefix', () => {
    const prefixed = synthCoreTemplate({}, 'stg');
    const ids = Object.keys(prefixed.findResources('AWS::SNS::Topic')).filter((logicalId) => logicalId.startsWith('OpsAlarms'));
    expect(ids).toHaveLength(1);
    const id = itemAt(ids, 0);
    expect(publishGrantsOn(prefixed, id)).toStrictEqual([expectedPublishGrant(id, 'stg-voc-')]);
  });

  it('has no subscription and ignores a leftover -c alarmEmail', () => {
    expect(Object.keys(template.findResources('AWS::SNS::Subscription'))).toStrictEqual([]);
    const withEmail = synthCoreTemplate({ alarmEmail: 'ops@example.com' });
    expect(Object.keys(withEmail.findResources('AWS::SNS::Subscription'))).toStrictEqual([]);
  });

  it('names the API async-failure queue for the stack that imports it, encrypted with the Core CMK', () => {
    const queue = z.object({ Properties: z.object({ QueueName: z.unknown(), KmsMasterKeyId: z.unknown() }) })
      .parse(Object.entries(template.findResources('AWS::SQS::Queue'))
        .find(([logicalId]) => logicalId.startsWith('ApiAsyncInvokeFailures'))?.[1]).Properties;
    expect(JSON.stringify(queue.QueueName)).toContain(`${API_ASYNC_FAILURES_QUEUE_BASE_NAME}-`);
    expect(JSON.stringify(queue.KmsMasterKeyId)).toContain('VocKmsKey');
  });
});

/**
 * The alarm-publish Allow statements in the TopicPolicy of topic `topicId`, with
 * the stack-level tokens left as synthesized.
 */
function publishGrantsOn(template: Template, topicId: string): unknown[] {
  const PolicySchema = z.object({
    Properties: z.object({
      Topics: z.array(z.unknown()),
      PolicyDocument: z.object({ Statement: z.array(z.record(z.string(), z.unknown())) }),
    }),
  });
  return Object.values(template.findResources('AWS::SNS::TopicPolicy'))
    .map((resource) => PolicySchema.parse(resource).Properties)
    .filter((policy) => JSON.stringify(policy.Topics) === JSON.stringify([{ Ref: topicId }]))
    .flatMap((policy) => policy.PolicyDocument.Statement)
    .filter((statement) => statement.Effect === 'Allow');
}

function expectedPublishGrant(topicId: string, alarmNamePrefix: string): Record<string, unknown> {
  return {
    Sid: ALARM_PUBLISH_SID,
    Effect: 'Allow',
    Principal: { Service: 'cloudwatch.amazonaws.com' },
    Action: 'sns:Publish',
    Resource: { Ref: topicId },
    Condition: {
      StringEquals: { 'aws:SourceAccount': SYNTH_ACCOUNT },
      ArnLike: { 'aws:SourceArn': `arn:aws:cloudwatch:${SYNTH_REGION}:${SYNTH_ACCOUNT}:alarm:${alarmNamePrefix}*` },
    },
  };
}

describe('no stack deploys an alarm (alerting is turned on at runtime)', () => {
  const templates: [string, () => Template][] = [
    ['Core', memo(() => synthCoreTemplate())],
    ['Ingestion', memo(() => synthIngestionTemplate(discoverPluginIds()))],
    ['Processing', memo(() => synthProcessingTemplate())],
    ['Api', apiTemplateAllPlugins],
  ];

  it.each(templates)('%s synthesizes no CloudWatch alarm and no SNS subscription', (_stack, synth) => {
    expect(Object.keys(synth().findResources('AWS::CloudWatch::Alarm'))).toStrictEqual([]);
    expect(Object.keys(synth().findResources('AWS::SNS::Subscription'))).toStrictEqual([]);
  }, SYNTH_TIMEOUT_MS);

  it('the app has exactly one ALARM topic, so the publish grant on it covers every alarm action', () => {
    const topics = templates.flatMap(([, synth]) => Object.values(synth().findResources('AWS::SNS::Topic')));
    const names = topics.map((topic) => {
      const props: unknown = topic.Properties;
      return typeof props === 'object' && props !== null && 'DisplayName' in props ? String(props.DisplayName) : '';
    });
    // The only other topic is the morning brief's (VocProcessingStack, docs/briefing.md): its
    // messages go to each user's own email, never to an alarm, and it grants CloudWatch nothing.
    const sorted = [...names].sort(byCodeUnit);
    expect(sorted).toStrictEqual(['VoC morning brief', 'VoC operational alarms']);
  }, SYNTH_TIMEOUT_MS);
});

describe('the logs API is wired to run alerting', () => {
  const env = (): Record<string, unknown> => serviceEnvironment(apiTemplateAllPlugins(), 'voc-logs-api');
  const queues = (): Map<string, string> => new Map(rendered(env().OPS_ALERTS_QUEUES).split(',').map((pair) => {
    const [slug = '', name = ''] = pair.split('=');
    return [slug, name];
  }));

  it('names every failure queue exactly as its owning stack synthesizes it', () => {
    const ingestion = synthIngestionTemplate(discoverPluginIds());
    const processing = synthProcessingTemplate();
    expect(Object.fromEntries(queues())).toStrictEqual({
      'processing-dlq': rendered(queueNameOf(ingestion, 'ProcessingDLQ')),
      'ingest-schedule-dlq': rendered(queueNameOf(ingestion, 'IngestScheduleDLQ')),
      'aggregator-stream-failures': rendered(queueNameOf(processing, 'AggregatorStreamFailures')),
      'memory-extract-dlq': rendered(queueNameOf(processing, 'MemoryWorkersMemoryExtractDLQ')),
      'briefing-dlq': rendered(queueNameOf(processing, 'BriefingWorkerDLQ')),
      'api-async-failures': rendered(queueNameOf(synthCoreTemplate(), 'ApiAsyncInvokeFailures')),
    });
  }, SYNTH_TIMEOUT_MS);

  it('names the processor, the aggregator and every enabled ingestor as Processing / Ingestion do', () => {
    const ingestion = synthIngestionTemplate(discoverPluginIds());
    const processing = synthProcessingTemplate();
    expect(rendered(env().OPS_ALERTS_PROCESSOR_FUNCTION)).toBe(rendered(functionNameOf(processing, 'FeedbackProcessor')));
    expect(rendered(env().OPS_ALERTS_AGGREGATOR_FUNCTION)).toBe(rendered(functionNameOf(processing, 'AggregationProcessor')));
    const ingestors = Object.entries(ingestion.findResources('AWS::Lambda::Function'))
      .filter(([logicalId]) => logicalId.startsWith('Ingestor'))
      .map(([, fn]) => rendered(FunctionSchema.parse(fn).Properties.FunctionName))
      .sort(byCodeUnit);
    expect(ingestors.length).toBeGreaterThan(0);
    expect(rendered(env().OPS_ALERTS_INGESTOR_FUNCTIONS).split(',').sort(byCodeUnit)).toStrictEqual(ingestors);
  }, SYNTH_TIMEOUT_MS);

  it('never alarms on the board sign-up triggers, whose refusals count as Lambda Errors by design', () => {
    // A refused board sign-up MUST raise (that is how Cognito refuses it), so its Errors metric is not a fault.
    const watched = Object.values(env()).map(rendered).join(',');
    expect(watched).not.toMatch(/voc-board-/);
  });

  it('addresses the Core topic by its name and reserves a voc-alerts prefix for the alarms', () => {
    // formatArn writes partition/region/account literally when the stack has an env.
    expect(rendered(env().OPS_ALERTS_TOPIC_ARN))
      .toMatch(new RegExp(`^arn:(?:<AWS::Partition>|[^:<]+):sns:(?:<AWS::Region>|[^:<]+):(?:<AWS::AccountId>|[^:<]+):${ALARM_TOPIC_BASE_NAME}-<AWS::AccountId>-<AWS::Region>$`));
    expect(rendered(env().OPS_ALERTS_ALARM_PREFIX)).toBe(`${OPS_ALERT_ALARM_BASE_NAME}-<AWS::AccountId>-<AWS::Region>`);
    // Under the topic's publish grant (`alarm:voc-*`), or SNS would refuse every notification.
    expect(OPS_ALERT_ALARM_BASE_NAME.startsWith(ALARM_NAME_PREFIX)).toBe(true);
  });

  it('grants CloudWatch alarm writes only under the alert prefix, the read-only list on alarm:*, and SNS only on the topic', () => {
    const statements = policyStatementsOf(apiTemplateAllPlugins(), 'LogsLambdaRole');
    // cloudwatch:GetMetricData (the failure-queue ages, api-logs-diagnostics.ts) is a metrics read, not an alarm grant.
    const alarmGrants = statements.filter((s) => s.actions.some((action) => action.startsWith('cloudwatch:') && action !== 'cloudwatch:GetMetricData'));
    const byActions = alarmGrants.map((s) => [[...s.actions].sort(byCodeUnit).join(','), rendered(JSON.parse(s.resource))] as const);
    const arn = (name: string) => `^arn:(?:<AWS::Partition>|[^:<]+):cloudwatch:(?:<AWS::Region>|[^:<]+):(?:<AWS::AccountId>|[^:<]+):alarm:${name}$`;
    expect(byActions.map(([actions]) => actions).sort(byCodeUnit))
      .toStrictEqual(['cloudwatch:DeleteAlarms,cloudwatch:PutMetricAlarm', 'cloudwatch:DescribeAlarms']);
    // CloudWatch authorizes DescribeAlarms (a list call) against alarm:*, even with AlarmNamePrefix:
    // a prefix-scoped grant answered AccessDenied live. The writes must stay on the prefix.
    expect(byActions.find(([actions]) => actions.includes('PutMetricAlarm'))?.[1])
      .toMatch(new RegExp(arn(`${OPS_ALERT_ALARM_BASE_NAME}-<AWS::AccountId>-<AWS::Region>-\\*`)));
    expect(byActions.find(([actions]) => actions === 'cloudwatch:DescribeAlarms')?.[1]).toMatch(new RegExp(arn('\\*')));
    const snsGrants = statements.filter((s) => s.actions.some((action) => action.startsWith('sns:')));
    expect(snsGrants.map((s) => [[...s.actions].sort(byCodeUnit), s.resource.includes(`:${ALARM_TOPIC_BASE_NAME}-`), s.resource.includes('*')]))
      .toStrictEqual([[['sns:ListSubscriptionsByTopic', 'sns:Subscribe', 'sns:Unsubscribe'], true, false]]);
  });
});

describe('the email inbox DLQ is watched only when the inbox exists', () => {
  const queuesWith = (context: Record<string, unknown>): string => {
    const stack = new cdk.Stack(new cdk.App({ context }), 'Probe');
    const queues = opsAlertsWiring({ stack, uniqueName: (base) => base, enabledPlugins: [] }).environment.OPS_ALERTS_QUEUES;
    return queues ?? '';
  };

  it('adds email-intake-dlq with -c inboundEmailDomain', () => {
    expect(queuesWith({ inboundEmailDomain: 'voc.example.com' })).toContain('email-intake-dlq=voc-email-intake-dlq');
  });

  it('leaves it out when the inbox is off, and always watches the brief DLQ', () => {
    const queues = queuesWith({});
    expect(queues).not.toContain('email-intake-dlq');
    expect(queues).toContain('briefing-dlq=voc-briefing-dlq');
  });
});
