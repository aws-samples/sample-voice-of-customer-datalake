/**
 * The raw data lake is write-only for the producers (Well-Architected SEC03-BP02, finding IAM-1).
 *
 * Every ingestor role and the manual-import role only ever `put_object` under `raw/` (plugins/_shared/raw_archive.py,
 * shared/ingest_archive.py, manual_import_handler.py). They once held `grantReadWrite` on the whole bucket, which
 * includes `s3:DeleteObject*`: on a versioned bucket that is permanent deletion of every version of every object,
 * `raw/csv_upload/*` included, from code that parses untrusted internet content. Only voc-retention may delete
 * customer data (docs/source-policies.md), so these roles get PutObject on `raw/*` and nothing else.
 *
 * The S3 import ingestor only reads its staged file, so it gets read-only access to the import bucket (IAM-13).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { apiTemplateAllPlugins } from '../test-support/api-stack-template';
import { allowedActions, roleStatements, type NormalizedStatement } from '../test-support/iam-statements';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const ALL_SOURCES = ['webscraper', 'github_issues', 'web_reviews', 'app_reviews_ios', 'app_reviews_android',
  'synthetic_reviews', 's3_import'];
/** Logical-id fragments of the two buckets in the fixture templates. */
const RAW_BUCKET = 'RawData';
const IMPORT_BUCKET = 'ImportBucket';
/** S3 actions a write-only producer must never hold on the raw lake. */
const READ_OR_DELETE = /^s3:(Delete|Get|List)/;
/** S3 actions a read-only consumer must never hold on the import bucket. */
const WRITE_OR_DELETE = /^s3:(Delete|Put|Abort)/;

function roleIdsStartingWith(template: Template, ...prefixes: string[]): string[] {
  return Object.keys(template.findResources('AWS::IAM::Role'))
    .filter((id) => prefixes.some((prefix) => id.startsWith(prefix)));
}

/** Every S3 grant on the raw lake is PutObject-class, and only on `raw/*`. */
function expectWriteOnlyUnderRaw(roleId: string, statements: NormalizedStatement[]): void {
  const actions = allowedActions(statements, 's3:', RAW_BUCKET);
  expect(actions, roleId).toContain('s3:PutObject');
  expect(actions.filter((a) => READ_OR_DELETE.test(a)), roleId).toStrictEqual([]);
  const resources = statements
    .filter((s) => s.resource.includes(RAW_BUCKET) && s.actions.some((a) => a.startsWith('s3:')))
    .map((s) => s.resource);
  for (const resource of resources) expect(resource, roleId).toContain('/raw/*');
}

describe('ingestor roles write the raw lake, never read or delete it', () => {
  let statementsByRole: Map<string, NormalizedStatement[]>;

  beforeAll(() => {
    const template = synthIngestionTemplate(ALL_SOURCES);
    statementsByRole = new Map(roleIdsStartingWith(template, 'IngestionLambdaRole', 'IngestorRole')
      .map((roleId) => [roleId, roleStatements(template, roleId)]));
  }, SYNTH_TIMEOUT_MS);

  it('finds the shared and the dedicated ingestor roles', () => {
    expect(statementsByRole.size).toBeGreaterThan(1);
  });

  it('grants only PutObject under raw/*', () => {
    const writers = [...statementsByRole].filter(([, s]) => allowedActions(s, 's3:', RAW_BUCKET).length > 0);
    expect(writers.length).toBeGreaterThan(0);
    for (const [roleId, statements] of writers) expectWriteOnlyUnderRaw(roleId, statements);
  });

  it('gives the S3 import ingestor read-only access to the import bucket', () => {
    const readers = [...statementsByRole].map(([roleId, s]) => [roleId, allowedActions(s, 's3:', IMPORT_BUCKET)] as const)
      .filter(([, actions]) => actions.length > 0);
    expect(readers.length).toBeGreaterThan(0);
    for (const [roleId, actions] of readers) {
      expect(actions, roleId).toContain('s3:GetObject*');
      expect(actions.filter((a) => WRITE_OR_DELETE.test(a)), roleId).toStrictEqual([]);
    }
  });
}, SYNTH_TIMEOUT_MS);

describe('manual import writes the raw lake, never reads or deletes it', () => {
  it('grants only PutObject under raw/*', () => {
    const template = apiTemplateAllPlugins();
    const roleIds = roleIdsStartingWith(template, 'ManualImportLambdaRole');
    expect(roleIds).toHaveLength(1);
    for (const roleId of roleIds) expectWriteOnlyUnderRaw(roleId, roleStatements(template, roleId));
  });
}, SYNTH_TIMEOUT_MS);
