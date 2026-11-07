/**
 * VocIngestionStack: an ingestor declaring `infrastructure.ingestor.jobNotices` (s3_import) tells a reprocess
 * run's starter when it ends (docs/realtime.md). It runs on a DEDICATED role (never the shared one, so no
 * other plugin may publish), that role reads exactly the realtime endpoint parameter, the function is told
 * its name, and this stack grants no appsync action (VocApiStack attaches the `jobs` publish grant).
 */
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { roleStatements } from '../test-support/iam-statements';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { findWorkerFunction } from '../test-support/worker-function';
import { REALTIME_HTTP_DNS_PARAMETER_ENV, realtimeParameterName } from '../utils/realtime';

describe('VocIngestionStack job-end notices', () => {
  let template: Template;
  let fn: ReturnType<typeof findWorkerFunction>;

  beforeAll(() => {
    template = synthIngestionTemplate(['webscraper', 's3_import']);
    fn = findWorkerFunction(template, 'voc-ingestor-s3_import');
  });

  it('runs the s3_import ingestor on its own role', () => {
    expect(fn.Role['Fn::GetAtt'][0]).toMatch(/^IngestorRoleS3Import/);
  });

  it('tells it the endpoint parameter, and its role reads exactly that parameter', () => {
    expect(fn.Environment.Variables[REALTIME_HTTP_DNS_PARAMETER_ENV]).toBe(realtimeParameterName(undefined));
    const ssm = roleStatements(template, fn.Role['Fn::GetAtt'][0]).filter((s) => s.actions.some((a) => a.startsWith('ssm:')));
    expect(ssm.map((s) => s.actions)).toStrictEqual([['ssm:GetParameter']]);
    expect(ssm[0]?.resource).toContain(`parameter${realtimeParameterName(undefined)}`);
  });

  it('no other ingestor is told, and nothing here publishes', () => {
    const webscraper = findWorkerFunction(template, 'voc-ingestor-webscraper');
    expect(REALTIME_HTTP_DNS_PARAMETER_ENV in webscraper.Environment.Variables).toBe(false);
    expect(JSON.stringify(template.toJSON())).not.toContain('appsync:');
  });
});
