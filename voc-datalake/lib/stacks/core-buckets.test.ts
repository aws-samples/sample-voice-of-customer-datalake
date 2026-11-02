import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import {
  ABORT_MULTIPART_DAYS,
  ACCESS_LOGS_NONCURRENT_VERSION_DAYS,
  RAW_BUCKET_WORKSPACE_PREFIXES,
  RAW_LAYER_PREFIX,
  SCRATCH_EXPIRATION_DAYS,
  WEBSITE_NONCURRENT_VERSION_DAYS,
  WORKSPACE_NONCURRENT_VERSION_DAYS,
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
      workspace: WORKSPACE_NONCURRENT_VERSION_DAYS,
      website: WEBSITE_NONCURRENT_VERSION_DAYS,
      accessLogs: ACCESS_LOGS_NONCURRENT_VERSION_DAYS,
      abortMultipart: ABORT_MULTIPART_DAYS,
    }).toStrictEqual({ workspace: 90, website: 30, accessLogs: 30, abortMultipart: 7 });
  });

  it('WebsiteBucket expires noncurrent versions, aborts stale uploads and clears delete markers', () => {
    expect(versionedBucket('WebsiteBucket').Properties.LifecycleConfiguration.Rules).toStrictEqual([
      {
        Id: 'version-hygiene',
        Status: 'Enabled',
        NoncurrentVersionExpiration: { NoncurrentDays: WEBSITE_NONCURRENT_VERSION_DAYS },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_MULTIPART_DAYS },
      },
      { Id: 'remove-expired-delete-markers', Status: 'Enabled', ExpiredObjectDeleteMarker: true },
    ]);
  });

  it('RawDataBucket expires noncurrent versions under each workspace prefix only, never under raw/', () => {
    expect(versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules).toStrictEqual([
      { Id: 'abort-incomplete-uploads', Status: 'Enabled',
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_MULTIPART_DAYS } },
      { Id: 'remove-expired-delete-markers', Status: 'Enabled', ExpiredObjectDeleteMarker: true },
      ...RAW_BUCKET_WORKSPACE_PREFIXES.map((prefix) => ({
        Id: `noncurrent-${prefix.slice(0, -1)}`, Status: 'Enabled', Prefix: prefix,
        NoncurrentVersionExpiration: { NoncurrentDays: WORKSPACE_NONCURRENT_VERSION_DAYS },
      })),
      { Id: 'scratch-expiry', Status: 'Enabled', Prefix: 'scratch/', ExpirationInDays: SCRATCH_EXPIRATION_DAYS },
    ]);
    expect(RAW_BUCKET_WORKSPACE_PREFIXES).toStrictEqual(
      ['avatars/', 'company-context/', 'memory-imports/', 'projects/', 'prototypes/', 'scratch/']);
  });

  it('no raw-bucket lifecycle rule can expire anything under raw/ (bronze keeps every version)', () => {
    const rules = versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules;
    const expiring = rules.filter((rule) => 'NoncurrentVersionExpiration' in rule || 'ExpirationInDays' in rule
      || 'ExpirationDate' in rule || 'Transitions' in rule || 'NoncurrentVersionTransitions' in rule);
    for (const rule of expiring) {
      const prefix = z.string().parse(rule['Prefix']);
      expect(prefix.startsWith(RAW_LAYER_PREFIX) || RAW_LAYER_PREFIX.startsWith(prefix), String(rule['Id'])).toBe(false);
    }
  });

  it('never expires current raw-data versions outside scratch/ (raw customer data is kept forever)', () => {
    const rules = versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules;
    expect(rules.filter((rule) => 'ExpirationInDays' in rule || 'ExpirationDate' in rule)).toStrictEqual([
      { Id: 'scratch-expiry', Status: 'Enabled', Prefix: 'scratch/', ExpirationInDays: SCRATCH_EXPIRATION_DAYS },
    ]);
  });
});

/**
 * The bronze layer is write-once at the bucket, not only in our code: a PutObject (or
 * CompleteMultipartUpload) under raw/ without If-None-Match is denied for every principal,
 * multipart parts exempted as AWS documents
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html).
 */
describe('VocCoreStack raw bucket policy', () => {
  const StatementSchema = z.looseObject({ Sid: z.string().optional() });
  const PolicySchema = z.object({
    Properties: z.object({
      Bucket: z.object({ Ref: z.string() }),
      PolicyDocument: z.object({ Statement: z.array(StatementSchema) }),
    }),
  });

  it('denies a raw/ write without If-None-Match to everyone', () => {
    const template = synthCoreTemplate();
    const policies = Object.values(template.findResources('AWS::S3::BucketPolicy'))
      .map((resource) => PolicySchema.parse(resource).Properties)
      .filter((policy) => policy.Bucket.Ref.startsWith('RawDataBucket'));
    expect(policies).toHaveLength(1);
    const statements = itemAt(policies, 0).PolicyDocument.Statement
      .filter((statement) => statement.Sid === 'DenyRawWritesWithoutIfNoneMatch');
    expect(statements).toHaveLength(1);
    const statement = itemAt(statements, 0);
    expect({ ...statement, Resource: undefined }).toStrictEqual({
      Sid: 'DenyRawWritesWithoutIfNoneMatch',
      Effect: 'Deny',
      Principal: { AWS: '*' },
      Action: 's3:PutObject',
      Condition: { Null: { 's3:if-none-match': 'true' }, Bool: { 's3:ObjectCreationOperation': 'true' } },
      Resource: undefined,
    });
    expect(JSON.stringify(statement['Resource'])).toContain('/raw/*');
  });
});

/**
 * Every prefix a stack grants on the raw data bucket is either raw/ (no expiry) or a workspace
 * prefix with its own noncurrent-version rule. Read from the stack SOURCES (every
 * `rawDataBucket.grant*(…)` / `rawDataBucket.arnForObjects(…)` argument, string constants
 * resolved), so a new prefix cannot quietly keep every overwritten version forever.
 */
describe('raw bucket prefixes in lib/stacks', () => {
  const stacksDir = __dirname;
  const sources = readdirSync(stacksDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => readFileSync(join(stacksDir, file), 'utf-8'));
  const constants = new Map<string, string>();
  for (const source of sources) {
    for (const match of source.matchAll(/const ([A-Z][A-Z0-9_]*) = '([^']*)'/g)) {
      const [, name, value] = match;
      if (name !== undefined && value !== undefined) constants.set(name, value);
    }
  }
  /** Loop variables over raw/ whole-upload prefixes (retention-worker.ts `WHOLE_UPLOAD_PREFIXES`). */
  const RAW_ONLY_IDENTIFIERS = new Set(['prefix']);

  function grantedPrefixes(): string[] {
    const prefixes: string[] = [];
    for (const source of sources) {
      for (const call of source.matchAll(/rawDataBucket\.(?:grant\w*|arnForObjects)\(([^)]*)\)/g)) {
        const args = call[1] ?? '';
        const literal = /['`]([a-z][^'`$]*)/.exec(args)?.[1];
        const constant = /`\$\{(\w+)\}/.exec(args)?.[1];
        if (literal !== undefined) prefixes.push(literal);
        else if (constant !== undefined && RAW_ONLY_IDENTIFIERS.has(constant)) prefixes.push(RAW_LAYER_PREFIX);
        else if (constant !== undefined) prefixes.push(z.string().parse(constants.get(constant)));
      }
    }
    return prefixes;
  }

  it('finds the grants it checks', () => {
    expect(grantedPrefixes().length).toBeGreaterThan(10);
  });

  it('names only raw/ or a workspace prefix with a noncurrent rule', () => {
    const known: readonly string[] = [RAW_LAYER_PREFIX, ...RAW_BUCKET_WORKSPACE_PREFIXES];
    const tops = [...new Set(grantedPrefixes().map((prefix) => `${prefix.split('/')[0] ?? ''}/`))];
    expect(tops.filter((top) => !known.includes(top))).toStrictEqual([]);
  });
});
