/**
 * Exact DynamoDB WRITE grants (owner decision, wave C: no role holds a delete it does not use).
 *
 * `grantReadWriteData` hands a role all four write actions (PutItem, UpdateItem, DeleteItem, BatchWriteItem)
 * whatever its code calls, so a read-mostly API could delete rows it never touches. These helpers keep the read
 * side of CDK's grant (`grantReadData`: the reads, the table's indexes, kms:Decrypt) and grant ONLY the write
 * actions the role's handler calls, with the key actions `grantReadWriteData` added for a write.
 *
 * A role that must delete OPERATIONAL rows (a circuit-breaker row, a lock, a pointer, a form) in a table that also
 * holds customer or audit rows gets that delete pinned by `dynamodb:LeadingKeys` to those rows' partitions
 * ({@link grantKeyScopedWrites}), the pattern of lib/utils/cache-version-grants.ts. `ForAllValues` with a
 * DeleteItem / BatchWriteItem: every partition key the request names must match, and a write always names one
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html).
 *
 * What each role keeps and why: lib/customer-data-deletes.test.ts (the whole-app inventory of deleters).
 */
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

/** The DynamoDB item writes a role can be granted. */
export type TableWrite = 'PutItem' | 'UpdateItem' | 'DeleteItem' | 'BatchWriteItem';

/** What `grantReadWriteData` adds on the table's KMS key for a write (aws-dynamodb perms.ts KEY_WRITE_ACTIONS). */
const KEY_WRITE_ACTIONS = ['kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'] as const;

/** One Allow of `writes` on the table itself (never its indexes: a write names the table), plus the key actions. */
function addWriteStatement(
  table: dynamodb.ITable, grantee: iam.IGrantable, writes: readonly TableWrite[],
  conditions?: Record<string, Record<string, string[]>>,
): void {
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: writes.map((write) => `dynamodb:${write}`),
    resources: [table.tableArn],
    conditions,
  }));
  table.encryptionKey?.grant(grantee, ...KEY_WRITE_ACTIONS);
}

/** Grant `grantee` the table's reads plus exactly `writes` (none: a read-only grant). */
export function grantReadAndWrites(
  table: dynamodb.ITable, grantee: iam.IGrantable, writes: readonly TableWrite[],
): void {
  table.grantReadData(grantee);
  if (writes.length === 0) return;
  grantWrites(table, grantee, writes);
}

/** Grant exactly `writes` on the table (no reads), with the key actions a write needs. */
export function grantWrites(table: dynamodb.ITable, grantee: iam.IGrantable, writes: readonly TableWrite[]): void {
  if (writes.length === 0) throw new Error('grantWrites: name at least one write');
  addWriteStatement(table, grantee, writes);
}

/**
 * Grant `writes` only on items whose partition key matches one of `partitions` (`StringLike`: `*` allowed),
 * with the key actions a write needs.
 */
export function grantKeyScopedWrites(
  table: dynamodb.ITable, grantee: iam.IGrantable, writes: readonly TableWrite[], partitions: readonly string[],
): void {
  if (writes.length === 0 || partitions.length === 0) throw new Error('grantKeyScopedWrites: name writes and partitions');
  addWriteStatement(table, grantee, writes, { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...partitions] } });
}
