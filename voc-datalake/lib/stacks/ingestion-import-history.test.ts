/**
 * VocIngestionStack: the S3 import ingestor can write its import-history record (#237, docs/import-history.md).
 *
 * `plugins/s3_import/ingestor/handler.py` puts two rows per file into voc-aggregates through
 * `BaseIngestor.aggregates_table`, which exists only when `AGGREGATES_TABLE` is set. Both halves are pinned
 * here: the env var on the function, and a PutItem grant on that table on the function's own role.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import { capitalize } from '../plugin-loader';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { itemAt } from '../test-support/guards';

const FunctionSchema = z.object({
  Properties: z.object({
    Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) }),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
  }),
});
const PolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(z.object({ Ref: z.string() })),
    PolicyDocument: z.object({
      Statement: z.array(z.object({ Action: z.union([z.string(), z.array(z.string())]), Resource: z.unknown() })),
    }),
  }),
});

describe('VocIngestionStack S3 import history writes', () => {
  let template: Template;
  let fn: z.infer<typeof FunctionSchema>['Properties'];

  beforeAll(() => {
    template = synthIngestionTemplate(['s3_import']);
    const ids = Object.keys(template.findResources('AWS::Lambda::Function'))
      .filter((id) => id.startsWith(`Ingestor${capitalize('s3_import')}`));
    if (ids.length !== 1) throw new Error(`expected one s3_import ingestor, found ${ids.length}`);
    fn = FunctionSchema.parse(template.findResources('AWS::Lambda::Function')[itemAt(ids, 0)]).Properties;
  });

  it('names the aggregates table to the ingestor', () => {
    expect(JSON.stringify(fn.Environment.Variables.AGGREGATES_TABLE)).toContain('Aggregates');
  });

  it("grants PutItem on the aggregates table to the ingestor's own role", () => {
    const [roleId] = fn.Role['Fn::GetAtt'];
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .map((resource) => PolicySchema.parse(resource).Properties)
      .filter((policy) => policy.Roles.some((role) => role.Ref === roleId))
      .flatMap((policy) => policy.PolicyDocument.Statement);
    const putsToAggregates = statements.filter((statement) =>
      [statement.Action].flat().includes('dynamodb:PutItem') && JSON.stringify(statement.Resource).includes('Aggregates'));
    expect(putsToAggregates.length).toBeGreaterThan(0);
  });
});
