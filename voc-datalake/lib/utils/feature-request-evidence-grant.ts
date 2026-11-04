/**
 * Read access to voc-feature-requests for the roles that use feedback-board requests as evidence
 * (lambda/shared/feature_request_evidence.py, docs/project-workspace.md → Feature requests): the
 * Projects API (the wizards' live count), the persona and document generator jobs and the research
 * step. The loader only queries the listing index (`gsi1`: the boards, then the requests), so the
 * grant is `dynamodb:Query` and nothing else; the KMS decrypt comes with each role's existing
 * `kmsKey.grantEncryptDecrypt`. No write, no Scan, no GetItem: board requests are read as evidence,
 * never changed by a generation.
 */
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';

/** The environment variable the loader reads the table name from. */
export const FEATURE_REQUESTS_TABLE_ENV = 'FEATURE_REQUESTS_TABLE';

/** `dynamodb:Query` on the table and its indexes (exact-grants.ts narrows `index/*` to `gsi1`). */
export function grantFeatureRequestEvidenceRead(table: dynamodb.ITable, role: iam.IGrantable): void {
  table.grant(role, 'dynamodb:Query');
}

/** The read grant plus the table name on every function that runs with `role`. */
export function wireFeatureRequestEvidence(
  table: dynamodb.ITable, role: iam.IGrantable, functions: readonly lambda.Function[],
): void {
  grantFeatureRequestEvidenceRead(table, role);
  for (const fn of functions) {
    fn.addEnvironment(FEATURE_REQUESTS_TABLE_ENV, table.tableName);
  }
}
