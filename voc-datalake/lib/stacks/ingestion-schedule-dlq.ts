/**
 * VocIngestionStack's dead-letter queue for scheduled-ingestion events
 * EventBridge could not deliver (#253) — otherwise a throttled or unreachable
 * ingestor drops the tick silently. One queue for every schedule rule; the stack
 * creates it on first use, so a deployment with no scheduled plugin gets none.
 *
 * Resources are created on the stack itself (logical ids `IngestScheduleDLQ*`). The queue is encrypted with the
 * Core key, whose EventBridge grant (`allowEventBridgeToScheduleDlq`, below) is added by VocCoreStack, not here.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';

/** Sid of the Core key-policy statement that lets EventBridge write to the schedule DLQ. */
export const EVENTBRIDGE_DLQ_KEY_SID = 'AllowEventBridgeToDeadLetter';

export interface ScheduleDeadLetterQueueProps {
  /** Physical name: the stack's `uniqueName(INGEST_SCHEDULE_DLQ_BASE_NAME)` (alerting watches it, dlq-alarms.ts). */
  queueName: string;
  /** The Core data key: the deployment's one customer-managed key. */
  key: kms.IKey;
  /** The stack's TLS-only queue policy, shared with its other queues. */
  denyInsecureTransport: (queue: sqs.Queue) => void;
}

/**
 * The Core key's policy statement for EventBridge → the schedule DLQ (VocCoreStack only).
 *
 * One customer-managed key for the whole deployment (owner decision, the tenet 7
 * baseline). EventBridge writes as the events.amazonaws.com service principal, so
 * the KEY POLICY must admit it, and the key lives in VocCoreStack: the statement is
 * added there, from the queue's fixed physical name (the same `uniqueName()` the
 * Ingestion stack gives it), never from an Ingestion token, so no cross-stack
 * reference or key → queue → rule → key cycle appears. Least privilege: only
 * `kms:GenerateDataKey` / `kms:Decrypt`, only under the SQS encryption context of
 * that one queue's ARN, only from this account. A deployment with no scheduled
 * plugin has no such queue, and the statement then matches nothing.
 */
export function allowEventBridgeToScheduleDlq(key: kms.Key, queueName: string): void {
  const stack = cdk.Stack.of(key);
  key.addToResourcePolicy(new iam.PolicyStatement({
    sid: EVENTBRIDGE_DLQ_KEY_SID,
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
}

/** The DLQ itself, encrypted with the Core key (its EventBridge grant: `allowEventBridgeToScheduleDlq`). */
export function createScheduleDeadLetterQueue(stack: cdk.Stack, props: ScheduleDeadLetterQueueProps): sqs.Queue {
  const dlq = new sqs.Queue(stack, 'IngestScheduleDLQ', {
    queueName: props.queueName,
    encryption: sqs.QueueEncryption.KMS,
    encryptionMasterKey: props.key,
    retentionPeriod: cdk.Duration.days(14),
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  props.denyInsecureTransport(dlq);
  NagSuppressions.addResourceSuppressions(dlq, [{
    id: 'AwsSolutions-SQS3',
    reason: 'This queue IS the dead-letter queue of the ingestion schedule targets; nothing consumes it',
  }]);
  return dlq;
}
