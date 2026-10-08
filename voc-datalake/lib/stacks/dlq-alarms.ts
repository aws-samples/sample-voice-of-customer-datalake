/**
 * Dead-letter / failure-queue depth alarms (#247).
 *
 * Every queue that records work the platform gave up on — the processing DLQ,
 * the ingestion schedule DLQ, the memory-extract DLQ, the aggregator stream
 * failures and the API async-invoke failures — alarms the moment it holds a
 * message, so a rejected or failed record is visible instead of ageing out of
 * a 14-day queue unseen.
 *
 * ONE SNS topic carries every alarm. VocCoreStack owns it; the stacks deployed
 * after Core (Ingestion → Processing) address it by its deterministic,
 * prefix-aware name — the same pattern as lib/utils/function-names.ts — so no
 * new cross-stack export is added and no props change. VocApiStack adds no
 * alarm or queue of its own (resource ceiling, see API_ASYNC_FAILURES_QUEUE_BASE_NAME).
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/** Base physical name of the operational alarm topic (run through `uniqueName()`). */
export const ALARM_TOPIC_BASE_NAME = 'voc-ops-alarms';

/**
 * Base physical name of the API async-invoke failure queue (#253). VocCoreStack
 * owns the queue AND its alarm; VocApiStack's async-invoked Lambdas address it
 * by this name. VocApiStack synthesizes 497 resources with every plugin enabled
 * (CloudFormation's ceiling is 500), so the queue and its TLS policy live in Core.
 */
export const API_ASYNC_FAILURES_QUEUE_BASE_NAME = 'voc-api-async-failures';

/** CDK context key for the optional email subscriber of the alarm topic. */
export const ALARM_EMAIL_CONTEXT_KEY = 'alarmEmail';

/** The sampling window of every queue-depth alarm. */
const QUEUE_DEPTH_ALARM_PERIOD = cdk.Duration.minutes(5);

// Deliberately loose: SNS validates the address itself and sends a confirmation
// mail, so this only rejects values that cannot be an address at all (a typo'd
// flag value, a list, a number) before they reach a deploy. Checked without a
// backtracking regex: one `@`, no whitespace / `,` / `;`, a non-empty local
// part, and a domain with an inner dot.
const NOT_IN_AN_ADDRESS = /[\s,;]/;

function looksLikeEmail(value: string): boolean {
  const parts = value.split('@');
  if (parts.length !== 2 || NOT_IN_AN_ADDRESS.test(value)) return false;
  const [local = '', domain = ''] = parts;
  const dot = domain.indexOf('.');
  return local !== '' && dot > 0 && !domain.endsWith('.');
}

/**
 * The `alarmEmail` context value: `undefined` when unset or blank (no
 * subscription), the trimmed address otherwise. Anything present but unusable
 * throws at synth rather than deploying a topic nobody hears.
 */
export function parseAlarmEmail(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new Error(`-c ${ALARM_EMAIL_CONTEXT_KEY} must be a single email address string, got ${typeof raw}`);
  }
  const email = raw.trim();
  if (email === '') return undefined;
  if (!looksLikeEmail(email)) {
    throw new Error(`-c ${ALARM_EMAIL_CONTEXT_KEY} is not an email address: ${JSON.stringify(email)}`);
  }
  return email;
}

export interface AlarmTopicProps {
  /** Physical topic name: `uniqueName(ALARM_TOPIC_BASE_NAME)` of the owning stack. */
  topicName: string;
  /** Optional email subscriber; no subscription is created when undefined. */
  alarmEmail?: string;
  /**
   * The leading part every alarm name that notifies this topic shares, e.g.
   * `voc-` (or `stg-voc-` on a prefixed deployment): the owning stack's
   * `prefixed(ALARM_NAME_PREFIX)`. Scopes the CloudWatch publish grant to this
   * deployment's alarms. Every alarm is named `uniqueName(<voc-…queue>)-messages-visible`.
   */
  alarmNamePrefix: string;
}

/** Base of every alarm name (`voc-…`); run through the owning stack's `prefixed()`. */
export const ALARM_NAME_PREFIX = 'voc-';

/** Sid of the topic-policy statement that lets CloudWatch alarms publish. */
export const ALARM_PUBLISH_SID = 'AllowCloudWatchAlarmsToPublish';

/**
 * The topic-policy Allow CloudWatch alarms need to publish (F2, 2026-10).
 *
 * `enforceSSL: true` makes CDK write an explicit AWS::SNS::TopicPolicy, which
 * REPLACES SNS's default access policy (the one that let same-account sources
 * publish). Without this statement the policy is only the TLS Deny and every
 * alarm action fails with "CloudWatch Alarms is not authorized to perform:
 * SNS:Publish". Least privilege: publish only, only from this account's
 * alarms whose names start with `alarmNamePrefix`.
 */
function alarmPublishStatement(topic: sns.ITopic, alarmNamePrefix: string): iam.PolicyStatement {
  const stack = cdk.Stack.of(topic);
  return new iam.PolicyStatement({
    sid: ALARM_PUBLISH_SID,
    effect: iam.Effect.ALLOW,
    principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
    actions: ['sns:Publish'],
    resources: [topic.topicArn],
    conditions: {
      StringEquals: { 'aws:SourceAccount': stack.account },
      ArnLike: {
        'aws:SourceArn': `arn:${stack.partition}:cloudwatch:${stack.region}:${stack.account}:alarm:${alarmNamePrefix}*`,
      },
    },
  });
}

/**
 * The KMS-encrypted, TLS-only alarm topic (VocCoreStack only).
 *
 * Its own CMK: CloudWatch publishes as the cloudwatch.amazonaws.com service
 * principal, which cannot use the AWS-managed `alias/aws/sns` key, and admitting
 * it to the RETAINed Core data key would widen that key for every table and
 * bucket it protects.
 */
export class AlarmTopic extends Construct {
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlarmTopicProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    const key = new kms.Key(this, 'Key', {
      description: 'Encrypts the VoC operational alarm topic',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    key.addToResourcePolicy(new iam.PolicyStatement({
      sid: ALARM_PUBLISH_SID,
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:SourceAccount': stack.account } },
    }));

    this.topic = new sns.Topic(this, 'Topic', {
      topicName: props.topicName,
      displayName: 'VoC operational alarms',
      masterKey: key,
      enforceSSL: true,
    });
    // The key grant above is not enough: the topic policy must Allow too.
    this.topic.addToResourcePolicy(alarmPublishStatement(this.topic, props.alarmNamePrefix));
    if (props.alarmEmail !== undefined) {
      this.topic.addSubscription(new snsSubscriptions.EmailSubscription(props.alarmEmail));
    }
  }
}

/**
 * Durable record of API async invocations that failed or expired (#253): the
 * on-failure destination of every VocApiStack Lambda invoked with
 * InvocationType='Event' (see `importApiAsyncFailureQueue`). CMK-encrypted like
 * every other queue in the app, TLS-only, 14 days (SQS's ceiling) to inspect and
 * re-drive by hand. VocCoreStack only.
 */
export function createApiAsyncFailureQueue(scope: Construct, id: string, queueName: string, key: kms.IKey): sqs.Queue {
  const queue = new sqs.Queue(scope, id, {
    queueName,
    encryption: sqs.QueueEncryption.KMS,
    encryptionMasterKey: key,
    retentionPeriod: cdk.Duration.days(14),
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  NagSuppressions.addResourceSuppressions(queue, [{
    id: 'AwsSolutions-SQS3',
    reason: 'This queue IS the terminal failure record (a Lambda async on-failure destination); nothing consumes it, so it has no DLQ of its own',
  }]);
  return queue;
}

/**
 * The Core-owned API async-failure queue, addressed by name from VocApiStack.
 * `keyArn` makes a destination grant include the CMK the queue is encrypted with.
 */
export function importApiAsyncFailureQueue(scope: Construct, id: string, queueName: string, key: kms.IKey): sqs.IQueue {
  return sqs.Queue.fromQueueAttributes(scope, id, {
    queueArn: cdk.Stack.of(scope).formatArn({ service: 'sqs', resource: queueName }),
    keyArn: key.keyArn,
  });
}

/** The Core-owned alarm topic, addressed by name from a later stack. */
export function importAlarmTopic(scope: Construct, id: string, topicName: string): sns.ITopic {
  return sns.Topic.fromTopicArn(scope, id, cdk.Stack.of(scope).formatArn({ service: 'sns', resource: topicName }));
}

export interface QueueDepthAlarmProps {
  /**
   * The queue's physical name (`uniqueName(base)`). The metric is keyed on it
   * rather than on a construct, so a stack may alarm on a queue another stack
   * owns — which is how the API stack's queue is alarmed from VocCoreStack.
   */
  queueName: string;
  topic: sns.ITopic;
}

/**
 * Alarm when the queue holds any visible message: Maximum of
 * ApproximateNumberOfMessagesVisible > 0 over one 5-minute period. Missing data
 * (an idle queue publishes nothing, as does one not deployed yet) is not breaching.
 */
export function addQueueDepthAlarm(scope: Construct, id: string, props: QueueDepthAlarmProps): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, id, {
    alarmName: `${props.queueName}-messages-visible`,
    alarmDescription: 'This failure queue holds failed or rejected messages. Inspect them in the SQS console '
      + '(Send and receive messages > Poll), fix the cause, then re-drive or purge.',
    metric: new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensionsMap: { QueueName: props.queueName },
      period: QUEUE_DEPTH_ALARM_PERIOD,
      statistic: cloudwatch.Stats.MAXIMUM,
    }),
    threshold: 0,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(new cloudwatchActions.SnsAction(props.topic));
  return alarm;
}
