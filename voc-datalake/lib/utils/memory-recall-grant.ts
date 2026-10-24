/**
 * Direct COMPANY-memory recall for a shared generator (research, PR/FAQ, PRD,
 * personas, prototypes) — lambda/shared/job_knowledge.py.
 *
 * The generator reads voc-memory itself rather than through the memory Lambda:
 * a delegated call carries no human subject and resolves to the NOTHING scope,
 * so it would recall nothing. What recall needs, and nothing more:
 *   - Query (the company partition) + GetItem, and UpdateItem for
 *     `touch_used` (last_used_at on the memories it returned). No Put, no Delete.
 *   - KMS decrypt of the table's customer-managed key.
 *   - InvokeModel on the fixed Titan embedder only (the query vector).
 * Plus the `MEMORY_TABLE` environment variable (memory_store.MEMORY_TABLE_ENV).
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as lambda from 'aws-cdk-lib/aws-lambda';

import { embeddingModelArn } from './model-allowlist';

/** Environment variable the Python side reads (memory_store.MEMORY_TABLE_ENV). */
const MEMORY_TABLE_ENV = 'MEMORY_TABLE';

/** The DynamoDB actions a shared generator holds on voc-memory. */
export const MEMORY_RECALL_ACTIONS = ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:UpdateItem'] as const;

export interface MemoryRecallProps {
  memoryTable: dynamodb.ITable;
  kmsKey: kms.IKey;
  region: string;
}

export function grantSharedMemoryRecall(fn: lambda.Function, role: iam.IRole, props: MemoryRecallProps): void {
  props.memoryTable.grant(role, ...MEMORY_RECALL_ACTIONS);
  props.kmsKey.grantDecrypt(role);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [embeddingModelArn(props.region)],
  }));
  fn.addEnvironment(MEMORY_TABLE_ENV, props.memoryTable.tableName);
}
