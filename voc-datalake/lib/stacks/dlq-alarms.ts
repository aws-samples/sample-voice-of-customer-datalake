/**
 * The operational alarm topic and the failure queues alerting watches (#247).
 *
 * Every queue that records work the platform gave up on — the processing DLQ,
 * the ingestion schedule DLQ, the memory-extract DLQ, the aggregator stream
 * failures and the API async-invoke failures — can alarm the moment it holds a
 * message. Those alarms (plus processor / aggregator / ingestor errors) are NOT
 * deployed by CDK: an admin turns alerting on in Settings → Logs → Alerts, and
 * the logs API creates them at runtime (lambda/shared/ops_alerts.py). An alarm
 * costs money every hour it exists, so none exists until someone will hear it.
 *
 * ONE SNS topic carries every alarm. VocCoreStack owns it (a topic has no fixed
 * cost); the logs API addresses it, and every watched queue and function, by its
 * deterministic, prefix-aware name — the same pattern as lib/utils/function-names.ts —
 * so no cross-stack export is added. VocApiStack adds no queue of its own
 * (resource ceiling, see API_ASYNC_FAILURES_QUEUE_BASE_NAME).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import type { PluginManifest } from '../plugin-loader';
import { MEMORY_EXTRACT_DLQ_BASE_NAME } from './memory-workers';
import { BRIEFING_DLQ_BASE_NAME } from './briefing-worker';
import { GLOBAL_MCP_SERVICE_NAME } from '../utils/function-names';
import { inboundEmailConfig } from '../utils/inbound-email';

/** Base physical name of the operational alarm topic (run through `uniqueName()`). */
export const ALARM_TOPIC_BASE_NAME = 'voc-ops-alarms';

/**
 * Base physical name of the API async-invoke failure queue (#253). VocCoreStack
 * owns the queue; VocApiStack's async-invoked Lambdas address it
 * by this name. VocApiStack synthesizes 497 resources with every plugin enabled
 * (CloudFormation's ceiling is 500), so the queue and its TLS policy live in Core.
 */
export const API_ASYNC_FAILURES_QUEUE_BASE_NAME = 'voc-api-async-failures';

/** Base physical names of the other failure queues alerting watches (each owning stack's `uniqueName()`). */
export const PROCESSING_DLQ_BASE_NAME = 'voc-processing-dlq';
export const INGEST_SCHEDULE_DLQ_BASE_NAME = 'voc-ingest-schedule-dlq';
export const AGGREGATOR_STREAM_FAILURES_BASE_NAME = 'voc-aggregator-stream-failures';
/** The email inbox's dead-letter queue (VocIngestionStack, only with `-c inboundEmailDomain`). */
export const EMAIL_INTAKE_DLQ_BASE_NAME = 'voc-email-intake-dlq';

/** Base physical names of the processing Lambdas whose errors alerting watches. */
export const FEEDBACK_PROCESSOR_FUNCTION_BASE_NAME = 'voc-feedback-processor';
export const AGGREGATOR_FUNCTION_BASE_NAME = 'voc-aggregation-processor';

/** Base physical name of an enabled plugin's ingestor Lambda. */
export function ingestorFunctionBaseName(pluginId: string): string {
  return `voc-ingestor-${pluginId}`;
}

export interface AlarmTopicProps {
  /** Physical topic name: `uniqueName(ALARM_TOPIC_BASE_NAME)` of the owning stack. */
  topicName: string;
  /**
   * The leading part every alarm name that notifies this topic shares, e.g.
   * `voc-` (or `stg-voc-` on a prefixed deployment): the owning stack's
   * `prefixed(ALARM_NAME_PREFIX)`. Scopes the CloudWatch publish grant to this
   * deployment's alarms. Every runtime alarm is named `uniqueName(OPS_ALERT_ALARM_BASE_NAME)-<slug>`.
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
 * it to the Core data key would widen that key for every table and
 * bucket it protects.
 */
export function createAlarmTopic(scope: Construct, id: string, props: AlarmTopicProps): void {
  // A plain construct with the same id keeps every logical id the class form had.
  const construct = new Construct(scope, id);
  const stack = cdk.Stack.of(construct);

  const key = new kms.Key(construct, 'Key', {
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

  const topic = new sns.Topic(construct, 'Topic', {
    topicName: props.topicName,
    displayName: 'VoC operational alarms',
    masterKey: key,
    enforceSSL: true,
  });
  // The key grant above is not enough: the topic policy must Allow too.
  topic.addToResourcePolicy(alarmPublishStatement(topic, props.alarmNamePrefix));
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

/**
 * Base of every runtime alert alarm name: `uniqueName(OPS_ALERT_ALARM_BASE_NAME)-<slug>`.
 * It starts with ALARM_NAME_PREFIX, so the topic's publish grant covers it, and it
 * is reserved for alerting, so the logs API's CloudWatch grant is scoped to it and
 * "turn off" may delete everything under it.
 */
export const OPS_ALERT_ALARM_BASE_NAME = `${ALARM_NAME_PREFIX}alerts`;

interface OpsAlertsInputs {
  /** The stack the logs API Lambda lives in (for ARNs). */
  stack: cdk.Stack;
  /** That stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  /** The enabled plugins (pluginStatus); only those with an ingestor are watched. */
  enabledPlugins: PluginManifest[];
}

interface OpsAlertsWiring {
  environment: Record<string, string>;
  statements: iam.PolicyStatement[];
}

/** `slug=queueName` for every failure queue this deployment has. */
function watchedQueues(inputs: OpsAlertsInputs): string {
  const scheduled = inputs.enabledPlugins.some((p) => p.infrastructure.ingestor?.enabled && p.infrastructure.ingestor.schedule);
  const queues: [string, string][] = [
    ['processing-dlq', PROCESSING_DLQ_BASE_NAME],
    // Created by VocIngestionStack only when an enabled plugin has a schedule.
    ...(scheduled ? [['ingest-schedule-dlq', INGEST_SCHEDULE_DLQ_BASE_NAME] satisfies [string, string]] : []),
    ['aggregator-stream-failures', AGGREGATOR_STREAM_FAILURES_BASE_NAME],
    ['memory-extract-dlq', MEMORY_EXTRACT_DLQ_BASE_NAME],
    ['briefing-dlq', BRIEFING_DLQ_BASE_NAME],
    // Created by VocIngestionStack only when the email inbox is on.
    ...(inboundEmailConfig(inputs.stack.node) ? [['email-intake-dlq', EMAIL_INTAKE_DLQ_BASE_NAME] satisfies [string, string]] : []),
    ['api-async-failures', API_ASYNC_FAILURES_QUEUE_BASE_NAME],
  ];
  return queues.map(([slug, base]) => `${slug}=${inputs.uniqueName(base)}`).join(',');
}

/**
 * The environment and least-privilege grants the logs API needs to run alerting
 * (lambda/shared/ops_alerts.py reads the same variable names). Every resource is
 * exact: the one topic, and alarms under this deployment's alert prefix only.
 */
export function opsAlertsWiring(inputs: OpsAlertsInputs): OpsAlertsWiring {
  const { stack, uniqueName } = inputs;
  const topicArn = stack.formatArn({ service: 'sns', resource: uniqueName(ALARM_TOPIC_BASE_NAME) });
  const alarmPrefix = uniqueName(OPS_ALERT_ALARM_BASE_NAME);
  const ingestors = inputs.enabledPlugins
    .filter((p) => p.infrastructure.ingestor?.enabled)
    .map((p) => uniqueName(ingestorFunctionBaseName(p.id)));
  return {
    environment: {
      OPS_ALERTS_TOPIC_ARN: topicArn,
      OPS_ALERTS_ALARM_PREFIX: alarmPrefix,
      OPS_ALERTS_QUEUES: watchedQueues(inputs),
      OPS_ALERTS_PROCESSOR_FUNCTION: uniqueName(FEEDBACK_PROCESSOR_FUNCTION_BASE_NAME),
      OPS_ALERTS_AGGREGATOR_FUNCTION: uniqueName(AGGREGATOR_FUNCTION_BASE_NAME),
      OPS_ALERTS_INGESTOR_FUNCTIONS: ingestors.join(','),
      // Powertools `service` of /mcp/global (not deployment-unique: see docs/mcp.md → Alarms).
      OPS_ALERTS_MCP_SERVICE: GLOBAL_MCP_SERVICE_NAME,
    },
    statements: [
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms'],
        resources: [stack.formatArn({
          service: 'cloudwatch', resource: 'alarm', resourceName: `${alarmPrefix}-*`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        })],
      }),
      // DescribeAlarms is a LIST call: CloudWatch authorizes it against `alarm:*` even with an
      // AlarmNamePrefix (a prefix-scoped grant answers AccessDenied, seen live in 5.01.00). It
      // only reads alarm metadata; the writes above stay pinned to the deployment's prefix.
      new iam.PolicyStatement({
        actions: ['cloudwatch:DescribeAlarms'],
        resources: [stack.formatArn({
          service: 'cloudwatch', resource: 'alarm', resourceName: '*', arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        })],
      }),
      new iam.PolicyStatement({
        actions: ['sns:Subscribe', 'sns:Unsubscribe', 'sns:ListSubscriptionsByTopic'],
        resources: [topicArn],
      }),
    ],
  };
}

/** Why the alarm-ARN wildcards are the narrowest grants possible (cdk-nag AwsSolutions-IAM5). */
export const OPS_ALERTS_NAG_REASON = 'Alerting creates and deletes its CloudWatch alarms at runtime, so they are addressed '
  + 'by name prefix: the ARN pins this account, region and the deployment\'s reserved voc-alerts-<account>-<region>- prefix; '
  + 'no other alarm matches. cloudwatch:DescribeAlarms alone is granted on alarm:* because CloudWatch authorizes that '
  + 'read-only list call against alarm:* even when it is filtered by AlarmNamePrefix';
