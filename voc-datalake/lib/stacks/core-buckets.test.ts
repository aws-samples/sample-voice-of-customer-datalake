import { describe, it, expect, beforeAll } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import {
  ABORT_MULTIPART_DAYS,
  ACCESS_LOGS_NONCURRENT_VERSION_DAYS,
  RAW_NONCURRENT_VERSION_DAYS,
  WEBSITE_NONCURRENT_VERSION_DAYS,
} from './core-buckets';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { itemAt } from '../test-support/guards';

/**
 * Every core bucket is versioned (recover from an accidental overwrite/delete —
 * AWS S3 security best practice), and versioning is bounded: dropping the
 * lifecycle half silently turns it into unbounded storage growth, dropping the
 * versioning half makes a delete unrecoverable again. Same contract as the
 * S3-import bucket in ingestion-stack.test.ts.
 */
describe('VocCoreStack bucket versioning', () => {
  const VersionedBucketSchema = z.object({
    Properties: z.object({
      VersioningConfiguration: z.object({ Status: z.string() }),
      LifecycleConfiguration: z.object({ Rules: z.array(z.record(z.string(), z.unknown())) }),
    }),
  });

  let template: Template;
  beforeAll(() => {
    template = synthCoreTemplate();
  });

  function versionedBucket(prefix: string): z.infer<typeof VersionedBucketSchema> {
    const found = Object.entries(template.findResources('AWS::S3::Bucket'))
      .filter(([logicalId]) => logicalId.startsWith(prefix));
    expect(found, `expected exactly one bucket named ${prefix}*`).toHaveLength(1);
    return VersionedBucketSchema.parse(itemAt(found, 0)[1]);
  }

  it.each(['AccessLogsBucket', 'RawDataBucket', 'WebsiteBucket'])('%s has versioning enabled', (prefix) => {
    expect(versionedBucket(prefix).Properties.VersioningConfiguration).toStrictEqual({ Status: 'Enabled' });
  });

  it('pins the noncurrent-version retention windows', () => {
    expect({
      raw: RAW_NONCURRENT_VERSION_DAYS,
      website: WEBSITE_NONCURRENT_VERSION_DAYS,
      accessLogs: ACCESS_LOGS_NONCURRENT_VERSION_DAYS,
      abortMultipart: ABORT_MULTIPART_DAYS,
    }).toStrictEqual({ raw: 90, website: 30, accessLogs: 7, abortMultipart: 7 });
  });

  it.each([
    ['RawDataBucket', RAW_NONCURRENT_VERSION_DAYS],
    ['WebsiteBucket', WEBSITE_NONCURRENT_VERSION_DAYS],
  ])('%s expires noncurrent versions, aborts stale uploads and clears delete markers', (prefix, days) => {
    expect(versionedBucket(prefix).Properties.LifecycleConfiguration.Rules).toStrictEqual([
      {
        Id: 'version-hygiene',
        Status: 'Enabled',
        NoncurrentVersionExpiration: { NoncurrentDays: days },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_MULTIPART_DAYS },
      },
      { Id: 'remove-expired-delete-markers', Status: 'Enabled', ExpiredObjectDeleteMarker: true },
    ]);
  });

  it('never expires current raw-data versions (raw customer data is kept forever)', () => {
    const rules = versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules;
    expect(rules.filter((rule) => 'ExpirationInDays' in rule || 'ExpirationDate' in rule)).toStrictEqual([]);
  });
});
