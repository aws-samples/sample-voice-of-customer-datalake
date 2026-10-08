/**
 * Memory workers (VocProcessingStack) — docs/memory.md.
 *
 *   EventBridge 15 min → memory-scanner → SQS memory-extract (+DLQ) → memory-extractor
 *   EventBridge daily  → memory-retention
 *
 * The scanner finds assistant sessions in voc-conversations idle > 30 min with
 * messages past their cursor (voc-memory `MEMCURSOR`); the agent conductor and
 * the memory API (imports) enqueue onto the same queue. The extractor runs the
 * `memory` surface (Haiku 4.5 on Flex) and embeds with Titan V2. Retention
 * archives decayed/expired items — it never deletes.
 *
 * Every role is an exact DynamoDB action set, pinned against
 * memory-agents-dynamodb-grants.json by memory-agents-stack.test.ts (the same
 * file the backend suite enforces on every moto call, lambda/shared/test/strict_iam.py);
 * none holds DeleteItem anywhere: forget = tombstone + archive.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { stackModelArns, embeddingModelArn } from '../utils/model-allowlist';
import { createWorkerFunction, scheduleWorker, workerRole } from '../utils/worker-lambda';

/** Extractor ceiling; the queue's visibility timeout is derived from it. */
const EXTRACTOR_TIMEOUT = cdk.Duration.minutes(5);

/** Base physical name of the memory-extract DLQ (the owning stack alarms on it, #247). */
export const MEMORY_EXTRACT_DLQ_BASE_NAME = 'voc-memory-extract-dlq';

export interface MemoryWorkersProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  memoryTable: dynamodb.ITable;
  conversationsTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  rawDataBucket: s3.IBucket;
}

export class MemoryWorkers extends Construct {
  public readonly extractQueue: sqs.Queue;
  public readonly extractor: lambda.Function;

  constructor(scope: Construct, id: string, private readonly props: MemoryWorkersProps) {
    super(scope, id);
    this.extractQueue = this.createExtractQueue();
    this.extractor = this.createExtractor();
    this.createScanner();
    this.createRetention();
  }

  private createExtractQueue(): sqs.Queue {
    const { uniqueName, kmsKey } = this.props;
    const dlq = new sqs.Queue(this, 'MemoryExtractDLQ', {
      queueName: uniqueName(MEMORY_EXTRACT_DLQ_BASE_NAME),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    return new sqs.Queue(this, 'MemoryExtractQueue', {
      queueName: uniqueName('voc-memory-extract'),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      // AWS guidance for an SQS event source: >= 6x the function timeout, so a
      // slow batch is not redelivered while it is still running.
      visibilityTimeout: cdk.Duration.seconds(EXTRACTOR_TIMEOUT.toSeconds() * 6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }

  /** SQS consumer: session/import/agent-run text -> memory items. */
  private createExtractor(): lambda.Function {
    const { uniqueName, kmsKey, memoryTable, conversationsTable, aggregatesTable, rawDataBucket } = this.props;
    const { region } = cdk.Stack.of(this);
    const role = workerRole(this, 'MemoryExtractorRole');
    // Memories (pools, dedup, writes, audit), import records, and the session
    // cursors it reads in one BatchGetItem (store.get_cursors) and advances.
    memoryTable.grant(role, 'dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
    conversationsTable.grant(role, 'dynamodb:GetItem');
    // No voc-agents grant: an agent-run source arrives as text on the queue
    // (the conductor sends it), so the extractor never reads that table.
    // Model-picker override, company objectives (alignment), category config.
    aggregatesTable.grant(role, 'dynamodb:GetItem');
    // Page imports: the original text the memory API stored.
    rawDataBucket.grantRead(role, 'memory-imports/*');
    kmsKey.grantEncryptDecrypt(role);
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: ['bedrock:InvokeModel'],
      // 'memory' is a picker surface (repointable), plus the fixed embedder.
      resources: [...stackModelArns(this), embeddingModelArn(region)],
    }));

    const fn = createWorkerFunction(this, 'MemoryExtractor', {
      tree: 'memory',
      functionName: uniqueName('voc-memory-extractor'),
      handler: 'memory/extractor/handler.lambda_handler',
      role,
      layer: this.props.layer,
      timeout: EXTRACTOR_TIMEOUT,
      memorySize: 1024,
      serviceName: 'voc-memory-extractor',
      environment: {
        MEMORY_TABLE: memoryTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        CONVERSATIONS_TABLE: conversationsTable.tableName,
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
      },
    });
    // The event source grants consume (incl. kms:Decrypt) on the queue.
    fn.addEventSource(new lambdaEventSources.SqsEventSource(this.extractQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
    }));
    return fn;
  }

  /** Every 15 min: enqueue idle assistant sessions with unseen messages. */
  private createScanner(): void {
    const { uniqueName, kmsKey, memoryTable, conversationsTable } = this.props;
    const role = workerRole(this, 'MemoryScannerRole');
    // No updatedAt index on conversations: a paged Scan with a filter.
    conversationsTable.grant(role, 'dynamodb:Scan');
    // Session cursors (MEMCURSOR / SESSION#...): read in one BatchGetItem
    // (store.get_cursors), advanced with UpdateItem (store.save_cursor). Without
    // BatchGetItem every run failed AccessDenied and no session was ever queued.
    memoryTable.grant(role, 'dynamodb:BatchGetItem', 'dynamodb:UpdateItem');
    kmsKey.grantEncryptDecrypt(role);
    this.extractQueue.grantSendMessages(role);

    const fn = createWorkerFunction(this, 'MemoryScanner', {
      tree: 'memory',
      functionName: uniqueName('voc-memory-scanner'),
      handler: 'memory/scanner/handler.lambda_handler',
      role,
      layer: this.props.layer,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024, // CPU: 81.6 % p95 at 512 MB (docs/lambda-sizing.md)
      serviceName: 'voc-memory-scanner',
      environment: {
        MEMORY_TABLE: memoryTable.tableName,
        CONVERSATIONS_TABLE: conversationsTable.tableName,
        MEMORY_EXTRACT_QUEUE_URL: this.extractQueue.queueUrl,
      },
    });
    scheduleWorker(this, 'MemoryScannerSchedule', fn, uniqueName('voc-memory-scanner-schedule'),
      events.Schedule.rate(cdk.Duration.minutes(15)));
  }

  /** Daily: decay (90 days untouched) and dated (past expires_at) -> archived. */
  private createRetention(): void {
    const { uniqueName, kmsKey, memoryTable } = this.props;
    const role = workerRole(this, 'MemoryRetentionRole');
    // Query the status index, archive in place (UpdateItem), append an audit event (PutItem).
    memoryTable.grant(role, 'dynamodb:Query', 'dynamodb:UpdateItem', 'dynamodb:PutItem');
    kmsKey.grantEncryptDecrypt(role);

    const fn = createWorkerFunction(this, 'MemoryRetention', {
      tree: 'memory',
      functionName: uniqueName('voc-memory-retention'),
      handler: 'memory/retention/handler.lambda_handler',
      role,
      layer: this.props.layer,
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      serviceName: 'voc-memory-retention',
      environment: { MEMORY_TABLE: memoryTable.tableName },
    });
    scheduleWorker(this, 'MemoryRetentionSchedule', fn, uniqueName('voc-memory-retention-schedule'),
      // 03:15 UTC - off the quarter-hour the scanner and heartbeat fire on.
      events.Schedule.cron({ hour: '3', minute: '15' }));
  }
}
