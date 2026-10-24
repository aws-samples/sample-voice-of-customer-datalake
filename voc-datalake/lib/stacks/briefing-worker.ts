/**
 * The per-user morning brief (VocProcessingStack) — docs/briefing.md.
 *
 *   EventBridge 15 min → voc-briefing (dispatch) → SQS voc-briefing (+DLQ) → voc-briefing (build)
 *   POST /settings/my-briefing/refresh (VocApiStack, settings API) ─────────┘
 *   build → SNS voc-briefing-<acct>-<region> (KMS) → the reader's own email subscription
 *
 * One function, two entry points: the schedule reads only the `BRIEFSUB`
 * subscriber partition (nobody subscribed = one empty Query per tick), and the
 * queue builds one user's brief at a time, at most 2 concurrently, so briefs never
 * crowd the Bedrock quota. Pay per use only: no provisioned capacity, no always-on
 * compute; a deployment where nobody subscribes or presses Refresh makes no model call.
 *
 * The topic has no subscriptions in the template: the settings API subscribes a
 * user's own verified Cognito email at runtime, with the filter policy
 * `{"sub": [<sub>]}`, and every message carries that `sub` attribute.
 */
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import { embeddingModelArn, stackModelArns } from '../utils/model-allowlist';
import { createWorkerFunction, scheduleWorker, workerRole } from '../utils/worker-lambda';

/** Base physical name of the brief queue, function and topic (`uniqueName()` adds account + region). */
const BRIEFING_BASE_NAME = 'voc-briefing';
export const BRIEFING_DLQ_BASE_NAME = 'voc-briefing-dlq';
const BUILD_TIMEOUT = cdk.Duration.minutes(5);
/** At most this many briefs are built at once (the Bedrock quota is shared). */
export const BRIEFING_MAX_CONCURRENCY = 2;

export interface BriefingWorkerProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  feedbackTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  memoryTable: dynamodb.ITable;
  agentsTable: dynamodb.ITable;
  projectsTable: dynamodb.ITable;
  /** voc-radar, read-only: the Radar cards on Home (lambda/briefing/radar_cards.py). */
  radarTable: dynamodb.ITable;
  userPool: cognito.IUserPool;
}

export function createBriefingWorker(scope: Construct, id: string, props: BriefingWorkerProps): void {
  // A plain construct with the same id keeps every logical id the class form had.
  const worker = new Construct(scope, id);
  const queue = createBriefingQueue(worker, props);
  const topic = new sns.Topic(worker, 'Topic', {
    topicName: props.uniqueName(BRIEFING_BASE_NAME),
    displayName: 'VoC morning brief',
    masterKey: props.kmsKey,
    enforceSSL: true,
  });
  createBriefingFunction(worker, props, queue, topic);
}

/** A CMK-encrypted, TLS-only queue, destroyed with the stack (it holds only build requests). */
function briefingQueueWith(worker: Construct, kmsKey: kms.IKey, id: string, props: sqs.QueueProps): sqs.Queue {
  return new sqs.Queue(worker, id, {
    ...props, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: kmsKey,
    enforceSSL: true, removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}

function createBriefingQueue(worker: Construct, props: BriefingWorkerProps): sqs.Queue {
  const { uniqueName, kmsKey } = props;
  const dlq = briefingQueueWith(worker, kmsKey, 'DLQ', {
    queueName: uniqueName(BRIEFING_DLQ_BASE_NAME), retentionPeriod: cdk.Duration.days(14),
  });
  NagSuppressions.addResourceSuppressions(dlq, [{
    id: 'AwsSolutions-SQS3',
    reason: 'This queue IS the dead-letter queue of voc-briefing; a DLQ has no DLQ of its own',
  }]);
  return briefingQueueWith(worker, kmsKey, 'Queue', {
    queueName: uniqueName(BRIEFING_BASE_NAME),
    // >= 6x the function timeout (AWS guidance for an SQS event source).
    visibilityTimeout: cdk.Duration.seconds(BUILD_TIMEOUT.toSeconds() * 6),
    deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
  });
}

function grantBriefingReads(worker: Construct, props: BriefingWorkerProps, role: iam.Role): void {
  const { kmsKey, feedbackTable, aggregatesTable, memoryTable, agentsTable, projectsTable, radarTable, userPool } = props;
  // Reviews on the date / urgency indexes (signals, quotes).
  // Urgent reviews: keys from the urgency index (INCLUDE projection), then the fields by key.
  feedbackTable.grant(role, 'dynamodb:BatchGetItem', 'dynamodb:Query');
  // Counters, category config, access rows, preferences, BRIEF#/BRIEFORG#/BRIEFSUB rows.
  aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
  // Memory recall (pool Query, touch-used UpdateItem) and the review queue counts.
  memoryTable.grant(role, 'dynamodb:Query', 'dynamodb:UpdateItem');
  // Agents listing (needs_human runs).
  agentsTable.grant(role, 'dynamodb:Query');
  // The reader's projects (by-type index) and their own MCP tokens (pointer Query + BatchGet).
  projectsTable.grant(role, 'dynamodb:Query', 'dynamodb:BatchGetItem');
  // Radar cards: releases, counters and reviews (Query), the stored brand list (GetItem). Never a write.
  radarTable.grant(role, 'dynamodb:GetItem', 'dynamodb:Query');
  kmsKey.grantEncryptDecrypt(role);
  // The reader is re-checked on every build: enabled, same sub, current groups.
  userPool.grant(role, 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser');
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'BedrockInvoke',
    actions: ['bedrock:InvokeModel'],
    // The 'utility' picker surface (repointable) and the memory embedder.
    resources: [...stackModelArns(worker), embeddingModelArn(cdk.Stack.of(worker).region)],
  }));
}

function createBriefingFunction(worker: Construct, props: BriefingWorkerProps, queue: sqs.Queue, topic: sns.Topic): void {
  const { uniqueName, feedbackTable, aggregatesTable, memoryTable, agentsTable, projectsTable, radarTable, userPool } = props;
  const role = workerRole(worker, 'BriefingRole');
  grantBriefingReads(worker, props, role);
  // The dispatcher queues due subscribers; a build mails through the topic.
  queue.grantSendMessages(role);
  topic.grantPublish(role);

  const fn = createWorkerFunction(worker, 'Briefing', {
    tree: 'briefing',
    functionName: uniqueName(BRIEFING_BASE_NAME),
    handler: 'briefing/handler.lambda_handler',
    role,
    layer: props.layer,
    timeout: BUILD_TIMEOUT,
    memorySize: 1769, // one vCPU 2026-10-23: single-threaded Python gains nothing above it (lib/sizing/policy.ts)
    serviceName: BRIEFING_BASE_NAME,
    environment: {
      FEEDBACK_TABLE: feedbackTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      MEMORY_TABLE: memoryTable.tableName,
      AGENTS_TABLE: agentsTable.tableName,
      PROJECTS_TABLE: projectsTable.tableName,
      RADAR_TABLE: radarTable.tableName,
      USER_POOL_ID: userPool.userPoolId,
      BRIEFING_QUEUE_URL: queue.queueUrl,
      BRIEFING_TOPIC_ARN: topic.topicArn,
    },
  });
  fn.addEventSource(new lambdaEventSources.SqsEventSource(queue, {
    batchSize: 1,
    maxConcurrency: BRIEFING_MAX_CONCURRENCY,
    reportBatchItemFailures: true,
  }));
  scheduleWorker(worker, 'DispatchSchedule', fn, uniqueName('voc-briefing-dispatch'),
    events.Schedule.rate(cdk.Duration.minutes(15)));
}

/**
 * What the settings API (VocApiStack) needs to serve /settings/my-briefing: the
 * queue (Refresh), the topic (subscribe the caller's own email) and Cognito
 * AdminGetUser (read that email). Addressed by deterministic name — VocApiStack
 * deploys after VocProcessingStack — so no cross-stack export is added.
 */
export interface BriefingApiWiring {
  /** BRIEFING_QUEUE_URL, BRIEFING_TOPIC_ARN, USER_POOL_ID (shared/briefing_requests.py, briefing_subscription.py). */
  environment: Record<string, string>;
  /** Least privilege on exactly the queue, the topic and the user pool. */
  grant: (role: iam.IRole) => void;
}

export function briefingApiWiring(scope: Construct, uniqueName: (baseName: string) => string,
  kmsKey: kms.IKey, userPool: cognito.IUserPool): BriefingApiWiring {
  const stack = cdk.Stack.of(scope);
  const queue = sqs.Queue.fromQueueAttributes(scope, 'BriefingQueueRef', {
    queueArn: stack.formatArn({ service: 'sqs', resource: uniqueName(BRIEFING_BASE_NAME) }),
    keyArn: kmsKey.keyArn,
  });
  const topicArn = stack.formatArn({ service: 'sns', resource: uniqueName(BRIEFING_BASE_NAME) });
  return {
    environment: {
      BRIEFING_QUEUE_URL: queue.queueUrl,
      BRIEFING_TOPIC_ARN: topicArn,
      USER_POOL_ID: userPool.userPoolId,
    },
    grant: (role) => {
      queue.grantSendMessages(role);
      role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['sns:Subscribe', 'sns:Unsubscribe', 'sns:GetSubscriptionAttributes'],
        resources: [topicArn],
      }));
      userPool.grant(role, 'cognito-idp:AdminGetUser');
    },
  };
}
