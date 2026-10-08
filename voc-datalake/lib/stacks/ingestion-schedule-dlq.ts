/**
 * VocIngestionStack's dead-letter queue for scheduled-ingestion events
 * EventBridge could not deliver (#253) — otherwise a throttled or unreachable
 * ingestor drops the tick silently. One queue for every schedule rule; the stack
 * creates it on first use, so a deployment with no scheduled plugin gets none.
 *
 * Resources are created on the stack itself (logical ids `IngestScheduleDLQ*`).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { addQueueDepthAlarm } from './dlq-alarms';

export interface ScheduleDeadLetterQueueProps {
  /** Physical name: the stack's `uniqueName('voc-ingest-schedule-dlq')`. */
  queueName: string;
  /** The Core alarm topic its depth alarm (#247) notifies. */
  alarmTopic: sns.ITopic;
  /** The stack's TLS-only queue policy, shared with its other queues. */
  denyInsecureTransport: (queue: sqs.Queue) => void;
}

/**
 * Its own CMK rather than the Core key: EventBridge writes as the
 * events.amazonaws.com service principal, so the KEY POLICY must admit it, and
 * granting that on the Core key would edit VocCoreStack's (RETAINed) key policy
 * from this stack. The grant is scoped by the SQS encryption context to this
 * one queue's ARN, built from its fixed name (a token reference would close a
 * key → queue → rule → key cycle) and by source account.
 */
export function createScheduleDeadLetterQueue(stack: cdk.Stack, props: ScheduleDeadLetterQueueProps): sqs.Queue {
  const { queueName } = props;
  const key = new kms.Key(stack, 'IngestScheduleDLQKey', {
    description: 'Encrypts the scheduled-ingestion EventBridge dead-letter queue',
    enableKeyRotation: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  key.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'AllowEventBridgeToDeadLetter',
    principals: [new iam.ServicePrincipal('events.amazonaws.com')],
    actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
    resources: ['*'],
    conditions: {
      StringEquals: {
        'kms:EncryptionContext:aws:sqs:arn': stack.formatArn({ service: 'sqs', resource: queueName }),
        'aws:SourceAccount': stack.account,
      },
    },
  }));

  const dlq = new sqs.Queue(stack, 'IngestScheduleDLQ', {
    queueName,
    encryption: sqs.QueueEncryption.KMS,
    encryptionMasterKey: key,
    retentionPeriod: cdk.Duration.days(14),
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  props.denyInsecureTransport(dlq);
  NagSuppressions.addResourceSuppressions(dlq, [{
    id: 'AwsSolutions-SQS3',
    reason: 'This queue IS the dead-letter queue of the ingestion schedule targets; nothing consumes it',
  }]);
  addQueueDepthAlarm(stack, 'IngestScheduleDLQDepthAlarm', { queueName, topic: props.alarmTopic });
  return dlq;
}
