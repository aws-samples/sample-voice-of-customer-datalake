/**
 * VocIngestionStack: the S3 import ingestor can write its import-history record (#237, docs/import-history.md).
 *
 * `plugins/s3_import/ingestor/handler.py` puts two rows per file into voc-aggregates through
 * `BaseIngestor.aggregates_table`, which exists only when `AGGREGATES_TABLE` is set. Both halves are pinned
 * here: the env var on the function, and a PutItem grant on that table on the function's own role.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { findWorkerFunction } from '../test-support/worker-function';
import { allowedActions, roleStatements } from '../test-support/iam-statements';


describe('VocIngestionStack S3 import history writes', () => {
  let template: Template;
  let fn: ReturnType<typeof findWorkerFunction>;

  beforeAll(() => {
    template = synthIngestionTemplate(['s3_import']);
    fn = findWorkerFunction(template, 'voc-ingestor-s3_import');
  });

  it('names the aggregates table to the ingestor', () => {
    expect(JSON.stringify(fn.Environment.Variables.AGGREGATES_TABLE)).toContain('Aggregates');
  });

  it("grants PutItem on the aggregates table to the ingestor's own role", () => {
    const [roleId] = fn.Role['Fn::GetAtt'];
    expect(allowedActions(roleStatements(template, roleId), 'dynamodb:', 'Aggregates')).toContain('dynamodb:PutItem');
  });
});
