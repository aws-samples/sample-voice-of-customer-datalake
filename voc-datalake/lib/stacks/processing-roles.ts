/**
 * The feedback processor's and the aggregator's roles: one each, with only what its own handler calls
 * (owner decision, wave C: the processor and the aggregator get separate roles).
 *
 * Through 6.00 both functions ran as ONE `ProcessingLambdaRole`, so the aggregator (a DynamoDB-stream consumer that
 * only bumps counters) could call Bedrock, Comprehend and Translate, write raw/, consume the processing queue and
 * delete feedback items; the processor could do everything the aggregator does. The processor keeps the logical id
 * `ProcessingLambdaRole` (its role is not replaced); the aggregator gets `AggregatorLambdaRole`.
 *
 * Neither holds a delete on a customer-data table (lib/customer-data-deletes.test.ts). The idempotency table is
 * operational, not customer data: Powertools' persistence layer deletes the processor's IN_PROGRESS record when a
 * record fails, so the processor keeps DeleteItem there.
 */
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { grantClaudeModels } from '../utils/claude-model-grant';
import { grantReadAndWrites, grantWrites } from '../utils/table-write-grants';

/** Comprehend `comprehendActions` and Translate's TranslateText (neither takes a resource ARN, so `*`). Shared by
 *  the processor and the category reprocess worker, which enrich the same way. */
export function grantTextAnalysis(role: iam.Role, comprehendActions: readonly string[]): void {
  role.addToPolicy(new iam.PolicyStatement({ sid: 'ComprehendAnalysis', actions: [...comprehendActions], resources: ['*'] }));
  role.addToPolicy(new iam.PolicyStatement({ sid: 'TranslateText', actions: ['translate:TranslateText'], resources: ['*'] }));
}

export interface ProcessorRoleProps {
  readonly feedbackTable: dynamodb.ITable;
  readonly aggregatesTable: dynamodb.ITable;
  readonly idempotencyTable: dynamodb.ITable;
  readonly radarTable: dynamodb.ITable;
  readonly processingQueue: sqs.IQueue;
  readonly kmsKey: kms.IKey;
  readonly rawDataBucket: s3.IBucket;
}

/**
 * lambda/processor/handler.py: enrich one queued record and store it.
 *
 * - feedback: GetItem / Query (the existing item, its siblings) and PutItem (conditional create) / UpdateItem (a
 *   newer copy, a CSV row update): no delete;
 * - aggregates: reads (settings, categories, source profiles) and PutItem (validation / processing log rows);
 * - radar (another brand's reviews): the dedupe-marker read and one transaction of Put + counter Updates;
 * - idempotency: Powertools' record (Get / Put / Update / Delete);
 * - raw/: write-once Put of the inline raw_data fallback (lambda/shared/raw_fallback.py), no read, no delete;
 * - the processing queue, Bedrock (the 'enrichment' surface, any allowlisted model), Comprehend, Translate, KMS.
 */
export function createProcessorRole(scope: Construct, props: ProcessorRoleProps): iam.Role {
  const role = new iam.Role(scope, 'ProcessingLambdaRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });
  // Enrichment defaults to Haiku but admins can repoint the 'enrichment' surface via the picker, so grant every
  // allowlisted model (issue #96).
  grantClaudeModels(role, 'stream');
  grantTextAnalysis(role, ['comprehend:DetectSentiment', 'comprehend:DetectKeyPhrases', 'comprehend:DetectDominantLanguage']);
  grantReadAndWrites(props.feedbackTable, role, ['PutItem', 'UpdateItem']);
  grantReadAndWrites(props.aggregatesTable, role, ['PutItem']);
  props.idempotencyTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem');
  props.processingQueue.grantConsumeMessages(role);
  props.kmsKey.grantEncryptDecrypt(role);
  props.radarTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
  // Write-once under raw/ (the bucket policy refuses a put without If-None-Match). Put only: no read, no delete.
  props.rawDataBucket.grantPut(role, 'raw/*');
  return role;
}

export interface AggregatorRoleProps {
  readonly aggregatesTable: dynamodb.ITable;
  readonly idempotencyTable: dynamodb.ITable;
  readonly kmsKey: kms.IKey;
}

/**
 * lambda/aggregator/handler.py: the feedback table's stream → counters.
 *
 * - aggregates: reads (the earliest-date watermark, counters) and UpdateItem (counters, plain or in a transaction;
 *   the data-version bump): no put, no delete;
 * - idempotency: PutItem only, the per-record dedupe claim inside the counters' transaction (shared/idempotency.py);
 * - the stream read (DescribeStream / GetRecords / GetShardIterator / ListStreams, with kms:Decrypt) and the
 *   on-failure queue's SendMessage are granted by the event source and its destination, not here.
 *
 * No Bedrock, Comprehend, Translate, raw/ or processing-queue access, and no access to the feedback table's items.
 */
export function createAggregatorRole(scope: Construct, props: AggregatorRoleProps): iam.Role {
  const role = new iam.Role(scope, 'AggregatorLambdaRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });
  grantReadAndWrites(props.aggregatesTable, role, ['UpdateItem']);
  grantWrites(props.idempotencyTable, role, ['PutItem']);
  props.kmsKey.grantEncryptDecrypt(role);
  return role;
}
