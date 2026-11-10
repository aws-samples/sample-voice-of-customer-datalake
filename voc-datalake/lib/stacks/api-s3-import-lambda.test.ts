/**
 * The S3 import API's reprocess grants (issue #144, api-s3-import-lambda.ts, docs/data-lake-structure.md).
 *
 * `POST /s3-import/reprocess` invokes exactly the s3_import ingestor, by name, and
 * writes only its `SOURCE_RUN#s3_import` run rows. The partition is read from the
 * Python that writes it, so a rename on either side fails here.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  apiTemplate, apiTemplateAllPlugins, policyStatementsOf, readRepoFile, serviceEnvironment,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { S3_IMPORT_RUN_PARTITION } from './api-s3-import-lambda';

const ROLE = 'S3ImportLambdaRole';
const SERVICE = 'voc-s3-import-api';

function pythonRunPartition(): string {
  const value = /^SOURCE_RUN_PK = '([^']+)'/m.exec(readRepoFile('lambda', 'shared', 's3_import_runs.py'))?.[1];
  expect(value, 'could not read SOURCE_RUN_PK from lambda/shared/s3_import_runs.py').toBeDefined();
  return value ?? '';
}

beforeAll(() => {
  apiTemplate();
  apiTemplateAllPlugins();
}, SYNTH_TIMEOUT_MS);

describe('with the s3_import plugin enabled', () => {
  const statements = () => policyStatementsOf(apiTemplateAllPlugins(), ROLE);

  it('may invoke exactly the s3_import ingestor', () => {
    const invokes = statements().filter((s) => s.actions.includes('lambda:InvokeFunction'));
    expect(invokes).toHaveLength(1);
    expect(invokes[0]?.actions).toStrictEqual(['lambda:InvokeFunction']);
    expect(invokes[0]?.resource).toContain(':function:voc-ingestor-s3_import-');
    expect(invokes[0]?.resource).not.toContain('*');
  });

  it('reads and writes the aggregates table only in the run partition the handler uses', () => {
    expect(S3_IMPORT_RUN_PARTITION).toBe(pythonRunPartition());
    const dynamo = statements().filter((s) => s.actions.some((a) => a.startsWith('dynamodb:')));
    // Query is the duplicate-run check (409); the LeadingKeys condition still pins it to the run partition.
    expect(dynamo).toStrictEqual([{
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
      resource: expect.stringContaining('Aggregates'),
      condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [S3_IMPORT_RUN_PARTITION] } },
    }]);
  });

  it('hands the handler the ingestor name and the aggregates table', () => {
    const env = serviceEnvironment(apiTemplateAllPlugins(), SERVICE);
    expect(JSON.stringify(env['S3_IMPORT_INGESTOR_FUNCTION'])).toContain('voc-ingestor-s3_import-');
    expect(env['AGGREGATES_TABLE']).toBeDefined();
  });
});

describe('with the s3_import plugin disabled', () => {
  it('grants no invoke and no aggregates access, and sets no ingestor name', () => {
    const statements = policyStatementsOf(apiTemplate(), ROLE);
    expect(statements.filter((s) => s.actions.includes('lambda:InvokeFunction'))).toStrictEqual([]);
    expect(statements.filter((s) => s.actions.some((a) => a.startsWith('dynamodb:')))).toStrictEqual([]);
    expect(serviceEnvironment(apiTemplate(), SERVICE)['S3_IMPORT_INGESTOR_FUNCTION']).toBeUndefined();
  });
});
