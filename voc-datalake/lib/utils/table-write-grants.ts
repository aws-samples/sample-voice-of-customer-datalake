/**
 * Exact DynamoDB WRITE grants (owner decision, wave C: no role holds a delete it does not use).
 *
 * `grantReadWriteData` hands a role all four write actions (PutItem, UpdateItem, DeleteItem, BatchWriteItem)
 * whatever its code calls, so a read-mostly API could delete rows it never touches. These helpers keep the read
 * side of CDK's grant (`grantReadData`: the reads, the table's indexes, kms:Decrypt) and grant ONLY the write
 * actions the role's handler calls, with the key actions a write needs: CDK's write key actions, plus kms:Decrypt
 * for the write-only helpers, which have no read half to bring it.
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
/**
 * The key actions a write-only grant needs: a write to a table encrypted with a customer-managed key also needs
 * kms:Decrypt (DynamoDB decrypts the table key for the caller). `grantReadWriteData` gets it from its read half; a
 * write-only role has no read half, so without it the first write fails ("not authorized to perform: kms:Decrypt"),
 * as the ModelPin custom resource did on every fresh deployment. CDK's write grant also adds kms:DescribeKey; a
 * write never calls it, so it stays out (exact grants: only what the role's calls need).
 */
export const KEY_ACTIONS_FOR_WRITE_ONLY_GRANT = [...KEY_WRITE_ACTIONS, 'kms:Decrypt'] as const;

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
  table.encryptionKey?.grant(grantee, ...KEY_ACTIONS_FOR_WRITE_ONLY_GRANT);
}

/**
 * Grant `grantee` the table's reads plus exactly `writes` (none: a read-only grant). The writes go through
 * `table.grant` (the table and its indexes, like CDK's own read/write grants), so policy minimization folds them
 * into the read statement instead of adding one per table.
 */
export function grantReadAndWrites(
  table: dynamodb.ITable, grantee: iam.IGrantable, writes: readonly TableWrite[],
): void {
  table.grantReadData(grantee);
  if (writes.length === 0) return;
  table.grant(grantee, ...writes.map((write) => `dynamodb:${write}`));
  table.encryptionKey?.grant(grantee, ...KEY_WRITE_ACTIONS);
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
  attributes?: readonly string[],
): void {
  if (writes.length === 0 || partitions.length === 0) throw new Error('grantKeyScopedWrites: name writes and partitions');
  // `attributes`: the only attribute names the request may touch (`dynamodb:Attributes`, the key's included), so an
  // update limited to one field cannot rewrite any other.
  addWriteStatement(table, grantee, writes, {
    'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...partitions] },
    ...(attributes ? { 'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...attributes] } } : {}),
  });
}
