/**
 * DLQ / failure-queue depth alarms (#247) and the one alarm topic they notify.
 *
 * Every queue that records work the platform gave up on must alarm the moment
 * it holds a message; otherwise a rejected record ages out of a 14-day queue
 * unseen. These cases pin, per stack, that each such queue has EXACTLY one
 * alarm with the agreed shape, that the alarm notifies the Core topic, and that
 * the topic is encrypted, TLS-only and only email-subscribed on request.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { VocCoreStack } from './core-stack';
import { ALARM_NAME_PREFIX, ALARM_PUBLISH_SID, ALARM_TOPIC_BASE_NAME, API_ASYNC_FAILURES_QUEUE_BASE_NAME, parseAlarmEmail } from './dlq-alarms';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_ACCOUNT, SYNTH_REGION, committedFeatureFlags } from '../test-support/synth-app';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { itemAt } from '../test-support/guards';
import { byCodeUnit } from '../utils/compare';

const env = { account: SYNTH_ACCOUNT, region: SYNTH_REGION };

const AlarmSchema = z.object({
  Properties: z.object({
    AlarmName: z.unknown(),
    Namespace: z.string(),
    MetricName: z.string(),
    Dimensions: z.array(z.object({ Name: z.string(), Value: z.unknown() })),
    Period: z.number(),
    Statistic: z.string(),
    Threshold: z.number(),
    ComparisonOperator: z.string(),
    EvaluationPeriods: z.number(),
    DatapointsToAlarm: z.number(),
    TreatMissingData: z.string(),
    AlarmActions: z.array(z.unknown()),
  }),
});
type AlarmProps = z.infer<typeof AlarmSchema>['Properties'];

const QueueSchema = z.object({ Properties: z.object({ QueueName: z.unknown() }) });

function alarmsOf(template: Template): AlarmProps[] {
  return Object.values(template.findResources('AWS::CloudWatch::Alarm'))
    .map((resource) => AlarmSchema.parse(resource).Properties);
}

/**
 * The alarm's dimensions, serialized: `[{"Name":"QueueName","Value":<the queue's QueueName>}]`
 * for a depth alarm. Compared with {@link queueDimensionOf} so a second dimension fails too.
 */
function alarmDimensions(alarm: AlarmProps): string {
  return JSON.stringify(alarm.Dimensions);
}

/** The dimensions a depth alarm on `queueName` (a queue's synthesized QueueName) carries. */
function queueDimensionOf(queueName: unknown): string {
  return JSON.stringify([{ Name: 'QueueName', Value: queueName }]);
}

/** The synthesized `QueueName` of the one queue whose logical id starts with `prefix`. */
function queueNameOf(template: Template, prefix: string): unknown {
  const queues = Object.entries(template.findResources('AWS::SQS::Queue'))
    .filter(([logicalId]) => logicalId.startsWith(prefix));
  expect(queues.map(([logicalId]) => logicalId), `expected one ${prefix} queue`).toHaveLength(1);
  return QueueSchema.parse(itemAt(queues, 0)[1]).Properties.QueueName;
}

/** The agreed shape: Max(ApproximateNumberOfMessagesVisible) > 0 over one 5-minute period. */
const DEPTH_ALARM_SHAPE = {
  Namespace: 'AWS/SQS',
  MetricName: 'ApproximateNumberOfMessagesVisible',
  Period: 300,
  Statistic: 'Maximum',
  Threshold: 0,
  ComparisonOperator: 'GreaterThanThreshold',
  EvaluationPeriods: 1,
  DatapointsToAlarm: 1,
  TreatMissingData: 'notBreaching',
};

function depthAlarmShape(alarm: AlarmProps): typeof DEPTH_ALARM_SHAPE {
  return {
    Namespace: alarm.Namespace,
    MetricName: alarm.MetricName,
    Period: alarm.Period,
    Statistic: alarm.Statistic,
    Threshold: alarm.Threshold,
    ComparisonOperator: alarm.ComparisonOperator,
    EvaluationPeriods: alarm.EvaluationPeriods,
    DatapointsToAlarm: alarm.DatapointsToAlarm,
    TreatMissingData: alarm.TreatMissingData,
  };
}

/** One action, addressing the Core topic by its deterministic name (stacks after Core). */
const IMPORTED_TOPIC_ACTION = { actions: 1, sns: true, namedTopic: true };

function topicActionShape(alarm: AlarmProps): typeof IMPORTED_TOPIC_ACTION {
  const action = JSON.stringify(alarm.AlarmActions[0]);
  return {
    actions: alarm.AlarmActions.length,
    sns: action.includes(':sns:'),
    namedTopic: action.includes(`:${ALARM_TOPIC_BASE_NAME}-`),
  };
}

/** Every alarm's dimensions, sorted: equal to {@link expectedDimensions} iff each queue has exactly one. */
function alarmedQueues(alarms: AlarmProps[]): string[] {
  return alarms.map(alarmDimensions).sort(byCodeUnit);
}

function expectedDimensions(queueNames: unknown[]): string[] {
  return queueNames.map(queueDimensionOf).sort(byCodeUnit);
}

/**
 * Each alarm as {dimensions, shape, topic}, sorted — equal to {@link importedDepthAlarmsOn}
 * iff every queue has exactly one depth alarm of the agreed shape notifying the Core topic.
 */
function importedDepthAlarms(alarms: AlarmProps[]): { dimensions: string; shape: typeof DEPTH_ALARM_SHAPE; topic: typeof IMPORTED_TOPIC_ACTION }[] {
  return alarms
    .map((alarm) => ({ dimensions: alarmDimensions(alarm), shape: depthAlarmShape(alarm), topic: topicActionShape(alarm) }))
    .sort((a, b) => byCodeUnit(a.dimensions, b.dimensions));
}

function importedDepthAlarmsOn(queueNames: unknown[]): ReturnType<typeof importedDepthAlarms> {
  return expectedDimensions(queueNames)
    .map((dimensions) => ({ dimensions, shape: DEPTH_ALARM_SHAPE, topic: IMPORTED_TOPIC_ACTION }));
}

function synthCoreTemplate(context: Record<string, unknown> = {}, deploymentPrefix?: string): Template {
  const app = new cdk.App({
    context: { ...committedFeatureFlags(), 'aws:cdk:bundling-stacks': [], skipFrontendBuildCheck: true, ...context },
  });
  return Template.fromStack(new VocCoreStack(app, 'TestCoreStack', { env, brandName: 'TestBrand', deploymentPrefix }));
}

/** Synthesize once per file: the alarm cases below read the same three stacks. */
function memo<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => {
    value ??= make();
    return value;
  };
}


describe('parseAlarmEmail', () => {
  it('treats unset or blank as "no subscription"', () => {
    expect(parseAlarmEmail(undefined)).toBeUndefined();
    expect(parseAlarmEmail(null)).toBeUndefined();
    expect(parseAlarmEmail('  ')).toBeUndefined();
  });

  it('returns a trimmed address', () => {
    expect(parseAlarmEmail(' ops@example.com ')).toBe('ops@example.com');
  });

  it('throws on a value that cannot be an address', () => {
    expect(() => parseAlarmEmail('true')).toThrow(/alarmEmail/);
    expect(() => parseAlarmEmail('a@b.com,c@d.com')).toThrow(/alarmEmail/);
    expect(() => parseAlarmEmail(42)).toThrow(/alarmEmail/);
  });

  it.each(['ops@example', '@example.com', 'ops@.example.com', 'ops@example.com.', 'ops@@example.com', 'ops @example.com'])(
    'throws on %j, which has no address shape',
    (value) => {
      expect(() => parseAlarmEmail(value)).toThrow(/is not an email address/);
    },
  );
});

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

  it('has no subscription unless -c alarmEmail is set', () => {
    expect(Object.keys(template.findResources('AWS::SNS::Subscription'))).toStrictEqual([]);
  });

  it('subscribes the -c alarmEmail address by email', () => {
    const withEmail = synthCoreTemplate({ alarmEmail: 'ops@example.com' });
    const subscriptions = Object.values(withEmail.findResources('AWS::SNS::Subscription'))
      .map((resource) => z.object({ Properties: z.object({ Protocol: z.string(), Endpoint: z.string(), TopicArn: z.unknown() }) })
        .parse(resource).Properties);
    expect(subscriptions.map(({ Protocol, Endpoint }) => ({ Protocol, Endpoint })))
      .toStrictEqual([{ Protocol: 'email', Endpoint: 'ops@example.com' }]);
    expect(JSON.stringify(itemAt(subscriptions, 0).TopicArn)).toContain('OpsAlarmsTopic');
  });

  it('alarms on the API async-failure queue it owns, to the topic', () => {
    // The queue lives here, not in VocApiStack (resource ceiling, dlq-alarms.ts).
    const alarms = alarmsOf(template);
    expect(alarmedQueues(alarms)).toStrictEqual(expectedDimensions([queueNameOf(template, 'ApiAsyncInvokeFailures')]));
    expect(alarms.map(depthAlarmShape)).toStrictEqual([DEPTH_ALARM_SHAPE]);
    expect(itemAt(alarms, 0).AlarmActions).toStrictEqual([{ Ref: topic().id }]);
  });

  it('names the API async-failure queue for the stack that imports it, encrypted with the Core CMK', () => {
    const queue = z.object({ Properties: z.object({ QueueName: z.unknown(), KmsMasterKeyId: z.unknown() }) })
      .parse(Object.entries(template.findResources('AWS::SQS::Queue'))
        .find(([logicalId]) => logicalId.startsWith('ApiAsyncInvokeFailures'))?.[1]).Properties;
    expect(JSON.stringify(queue.QueueName)).toContain(`${API_ASYNC_FAILURES_QUEUE_BASE_NAME}-`);
    expect(JSON.stringify(queue.KmsMasterKeyId)).toContain('VocKmsKey');
  });
});

describe('VocIngestionStack DLQ alarms', () => {
  it('alarms on the processing DLQ and the schedule DLQ when a plugin is scheduled', () => {
    const template = synthIngestionTemplate(['webscraper', 'app_reviews_ios']);
    const alarms = alarmsOf(template);
    expect(importedDepthAlarms(alarms)).toStrictEqual(importedDepthAlarmsOn([
      queueNameOf(template, 'ProcessingDLQ'), queueNameOf(template, 'IngestScheduleDLQ'),
    ]));
  });

  it('alarms on the processing DLQ alone when no schedule DLQ exists', () => {
    const template = synthIngestionTemplate([]);
    const alarms = alarmsOf(template);
    expect(importedDepthAlarms(alarms)).toStrictEqual(importedDepthAlarmsOn([queueNameOf(template, 'ProcessingDLQ')]));
  });
});

describe('VocProcessingStack failure-queue alarms', () => {
  it('alarms on the aggregator stream failures and the memory-extract DLQ', () => {
    const template = synthProcessingTemplate();
    const alarms = alarmsOf(template);
    expect(importedDepthAlarms(alarms)).toStrictEqual(importedDepthAlarmsOn([
      queueNameOf(template, 'AggregatorStreamFailures'),
      queueNameOf(template, 'MemoryWorkersMemoryExtractDLQ'),
    ]));
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

/**
 * Every alarm, in every stack that has one, must fall inside the publish grant:
 * its action is the one alarm topic (which carries the grant, above) and its
 * name starts with the granted `voc-` prefix — otherwise SNS refuses its
 * notification silently, as it did for all of them before F2.
 */
describe('every alarm can publish to its action topic', () => {
  /** The leading literal of a synthesized name (a string, or Fn::Join's first part). */
  function leadingLiteral(name: unknown): string {
    if (typeof name === 'string') return name;
    const joined = z.object({ 'Fn::Join': z.tuple([z.string(), z.array(z.unknown())]) }).parse(name);
    const first = joined['Fn::Join'][1][0];
    return typeof first === 'string' ? first : '';
  }

  const templates: [string, () => Template][] = [
    ['Core', memo(() => synthCoreTemplate())],
    ['Ingestion', memo(() => synthIngestionTemplate(['webscraper', 'app_reviews_ios']))],
    ['Processing', memo(() => synthProcessingTemplate())],
  ];

  it.each(templates)('%s: alarm names sit under the granted prefix and target the alarm topic', (_stack, synth) => {
    const alarms = alarmsOf(synth());
    expect(alarms.length).toBeGreaterThan(0);
    for (const alarm of alarms) {
      expect(leadingLiteral(alarm.AlarmName)).toMatch(new RegExp(`^${ALARM_NAME_PREFIX}`));
      expect(alarm.AlarmActions).toHaveLength(1);
      const action = JSON.stringify(alarm.AlarmActions[0]);
      // Core refs the topic it owns; later stacks address it by its name.
      expect(action.includes('"Ref":"OpsAlarmsTopic') || action.includes(`:${ALARM_TOPIC_BASE_NAME}-`)).toBe(true);
    }
  });

  it('the app has exactly one SNS topic, so the grant on it covers every alarm action', () => {
    const topics = templates.flatMap(([, synth]) => Object.keys(synth().findResources('AWS::SNS::Topic')));
    expect(topics).toHaveLength(1);
  });
});
