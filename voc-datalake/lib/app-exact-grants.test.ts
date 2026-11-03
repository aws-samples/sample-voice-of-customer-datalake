/**
 * lib/utils/exact-grants.ts over the WHOLE app (bin/voc-datalake.ts, default synth): no identity-policy `Allow`
 * carries a CDK grant wildcard or a `<table>/index/*` resource, every index ARN names an index of the table it
 * is built from (cross-stack: through the producer's export), and the grants the platform's riskiest roles
 * hold are pinned exactly.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cmkTableReadWriteKms, grantActions, GrantStatementSchema, kmsGrants, type GrantStatement } from './test-support/exact-grant-statements';
import { cleanupAssemblyDirs, synthApp, SYNTH_REGION } from './test-support/synth-app';
import { TemplateResourcesSchema } from './test-support/template-resources';
import { byCodeUnit } from './utils/compare';
import { EXACT_ACTIONS } from './utils/exact-grants';

// One synth for the file, at module level like lib/app-template-gates.test.ts (~10 s, out of process).
const RESULT = synthApp();
afterAll(cleanupAssemblyDirs);

type Statement = GrantStatement;
const DocumentSchema = z.object({ Statement: z.array(GrantStatementSchema) });
const OutputsSchema = z.record(z.string(), z.object({ Value: z.unknown(), Export: z.object({ Name: z.string() }).optional() }));
const GetAttSchema = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) });
const IndexesSchema = z.array(z.object({ IndexName: z.string() })).optional();
const ImportedIndexSchema = z.object({
  'Fn::Join': z.tuple([z.literal(''), z.tuple([z.object({ 'Fn::ImportValue': z.string() }), z.string()])]),
});

interface Located { readonly stack: string; readonly id: string; readonly statement: Statement }

const resourcesOf = (stack: string) => TemplateResourcesSchema.parse(RESULT.template(stack).Resources ?? {});
const actionsOf = grantActions;
const listOf = (resource: unknown): unknown[] => (Array.isArray(resource) ? resource : [resource]);

const STATEMENTS: Located[] = RESULT.stackNames.flatMap((stack) => Object.entries(resourcesOf(stack))
  .filter(([, resource]) => resource.Type === 'AWS::IAM::Policy')
  .flatMap(([id, resource]) => DocumentSchema.parse(resource.Properties.PolicyDocument).Statement
    .map((statement) => ({ stack, id, statement }))));

/** The statements of the one policy whose logical id starts with `prefix` in `stack`. */
function policy(stack: string, prefix: string): Statement[] {
  const ids = new Set(STATEMENTS.filter((s) => s.stack === stack && s.id.startsWith(prefix)).map((s) => s.id));
  expect([...ids]).toHaveLength(1);
  return STATEMENTS.filter((s) => ids.has(s.id)).map((s) => s.statement);
}

/** Export name → the index names of the VocCoreStack table it exports. */
function exportedTableIndexes(): Map<string, string[]> {
  const resources = resourcesOf('VocCoreStack');
  const outputs = OutputsSchema.parse(RESULT.template('VocCoreStack').Outputs ?? {});
  const map = new Map<string, string[]>();
  for (const output of Object.values(outputs)) {
    const att = GetAttSchema.safeParse(output.Value);
    const table = att.success ? resources[att.data['Fn::GetAtt'][0]] : undefined;
    if (output.Export === undefined || table?.Type !== 'AWS::DynamoDB::Table') continue;
    const names = [table.Properties.GlobalSecondaryIndexes, table.Properties.LocalSecondaryIndexes]
      .flatMap((list) => IndexesSchema.parse(list) ?? []).map((index) => index.IndexName);
    map.set(output.Export.Name, names);
  }
  return map;
}

describe('exact grants over the app', () => {
  it('no Allow carries a CDK grant wildcard or a <table>/index/* resource', () => {
    const wildcards = new Set(Object.keys(EXACT_ACTIONS));
    const offending = STATEMENTS.filter(({ statement }) => statement.Effect === 'Allow' && (
      actionsOf(statement).some((action) => wildcards.has(action))
      || JSON.stringify(statement.Resource).includes('/index/*')));
    expect(offending.map(({ stack, id }) => `${stack}/${id}`)).toStrictEqual([]);
  });

  it('every cross-stack index ARN names an index of the table behind its export', () => {
    const indexes = exportedTableIndexes();
    const seen = STATEMENTS.flatMap(({ stack, statement }) => listOf(statement.Resource).flatMap((resource) => {
      const parsed = ImportedIndexSchema.safeParse(resource);
      if (!parsed.success) return [];
      const [, [imported, suffix]] = parsed.data['Fn::Join'];
      if (!suffix.startsWith('/index/')) return [];
      return [{ stack, exportName: imported['Fn::ImportValue'], index: suffix.slice('/index/'.length) }];
    }));
    expect(seen.length).toBeGreaterThan(50);
    expect(seen.filter(({ exportName, index }) => !(indexes.get(exportName) ?? []).includes(index))).toStrictEqual([]);
    // The feedback table, granted in the API stack, is reached through every one of its indexes there.
    const feedbackExport = [...indexes.keys()].find((name) => name.includes('FeedbackTable')) ?? '';
    const feedbackIndexes = indexes.get(feedbackExport) ?? [];
    expect(feedbackIndexes.length).toBeGreaterThan(1);
    const apiIndexes = seen.filter((s) => s.stack === 'VocApiStack' && s.exportName === feedbackExport);
    expect(new Set(apiIndexes.map((s) => s.index))).toStrictEqual(new Set(feedbackIndexes));
  });

  it('a CMK-encrypted table read/write grant: exact KMS actions, the DynamoDB-only ones through DynamoDB', () => {
    expect(kmsGrants(policy('VocApiStack', 'ManualImportProcessorRoleDefaultPolicy'))).toStrictEqual(cmkTableReadWriteKms(SYNTH_REGION));
  });

  it('a raw-bucket read grant: s3:GetObject and s3:ListBucket only', () => {
    const s3 = policy('VocProcessingStack', 'MemoryWorkersMemoryExtractorRoleDefaultPolicy')
      .filter((statement) => actionsOf(statement).some((action) => action.startsWith('s3:')));
    expect(s3.map(actionsOf)).toStrictEqual([['s3:GetObject', 's3:ListBucket']]);
  });

  it('the retention Lambda: explicit version deletes and listing, the whole-upload Deny keeps its wildcard', () => {
    const s3 = policy('VocProcessingStack', 'RetentionWorkerRetentionRoleDefaultPolicy')
      .filter((statement) => actionsOf(statement).some((action) => action.startsWith('s3:')))
      .map((statement) => [statement.Effect, [...actionsOf(statement)].sort(byCodeUnit)]);
    expect(s3).toStrictEqual([
      ['Allow', ['s3:DeleteObject', 's3:DeleteObjectVersion']],
      ['Deny', ['s3:DeleteObject*']],
      ['Allow', ['s3:ListBucketVersions']],
    ]);
  });

  it.each([
    ['ProjectsLambdaRole', ['avatars/*', 'projects/*/product_docs/*', 'prototypes/*']],
    ['PersonaGeneratorRole', ['avatars/*']],
    ['SettingsLambdaRole', ['company-context/design/logo_preview_*', 'company-context/design/icons_*']],
  ])('the workspace deleter %s: version deletes and listing on exactly its prefixes, never raw/', (role, prefixes) => {
    const s3 = policy('VocApiStack', `${role}DefaultPolicy`);
    const versionDeletes = s3.filter((statement) => actionsOf(statement).includes('s3:DeleteObjectVersion'));
    expect(versionDeletes).toHaveLength(1);
    expect(versionDeletes.flatMap(actionsOf)).toStrictEqual(expect.arrayContaining(
      ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:ListBucketVersions']));
    const objectPaths = [...JSON.stringify(versionDeletes[0]?.Resource).matchAll(/"\/([^"]*)"/g)]
      .flatMap((match) => match[1] ?? []);
    expect([...objectPaths].sort(byCodeUnit)).toStrictEqual([...prefixes].sort(byCodeUnit));
  });
});
