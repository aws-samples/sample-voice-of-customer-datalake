/**
 * VocIngestionStack: an ingestor declaring `infrastructure.ingestor.jobNotices` (s3_import) tells a reprocess
 * run's starter when it ends (docs/realtime.md). It runs on a DEDICATED role (never the shared one, so no
 * other plugin may publish), that role carries exactly VocCoreStack's `jobs` publish policy (core-realtime.ts),
 * the function is told the Event API's host, and no statement of this stack names an appsync action.
 */
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { FIXTURE_REALTIME_HTTP_DNS } from '../test-support/fixture-resources';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { findWorkerFunction } from '../test-support/worker-function';
import { REALTIME_HTTP_DNS_ENV } from '../utils/realtime';
import { expectPublishesOnlyOn, realtimeNamespacesOfRole } from '../test-support/realtime-assertions';

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

  it('tells it the Event API host, and its role publishes on exactly `jobs`', () => {
    expect(fn.Environment.Variables[REALTIME_HTTP_DNS_ENV]).toBe(FIXTURE_REALTIME_HTTP_DNS);
    expectPublishesOnlyOn(template, fn.Role['Fn::GetAtt'][0], 'jobs');
  });

  it('no other ingestor is told, and nothing here publishes', () => {
    const webscraper = findWorkerFunction(template, 'voc-ingestor-webscraper');
    expect(REALTIME_HTTP_DNS_ENV in webscraper.Environment.Variables).toBe(false);
    expect(realtimeNamespacesOfRole(template, webscraper.Role['Fn::GetAtt'][0])).toStrictEqual([]);
    expect(JSON.stringify(template.toJSON())).not.toContain('appsync:');
  });
});
