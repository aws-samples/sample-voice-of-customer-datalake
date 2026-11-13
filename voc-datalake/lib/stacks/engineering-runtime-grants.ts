/**
 * Two of the engineering runtime's grants (engineering-runtime.ts), kept apart so that file stays within its size:
 * the spend ledger's update (the session store's priced writes) and a KMS key's use through named services only.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';

import { ENGINEERING_SPEND_PARTITIONS } from './core-buckets';

/**
 * The spend ledger's rows (engineering/spend.py): the session store ADDs to them in the same transaction as each
 * priced write of a session (a transaction is authorised by its items' own actions), so every role that saves a
 * session needs this. UpdateItem only, on the month partitions only; no GetItem, Query or delete (IAM cannot limit
 * an update to ADDs: the code's ADD-only expressions do).
 */
export function grantSpendLedger(role: iam.IRole, table: dynamodb.ITable): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'SpendLedger',
    actions: ['dynamodb:UpdateItem'],
    resources: [table.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [ENGINEERING_SPEND_PARTITIONS] } },
  }));
}

/** `actions` on `key`, only when one of `services` (in this region) calls KMS for the role. */
export function viaServices(key: kms.IKey, actions: string[], services: string[]): iam.PolicyStatement {
  const region = cdk.Stack.of(key).region;
  return new iam.PolicyStatement({
    actions,
    resources: [key.keyArn],
    conditions: { StringEquals: { 'kms:ViaService': services.map((service) => `${service}.${region}.amazonaws.com`) } },
  });
}
