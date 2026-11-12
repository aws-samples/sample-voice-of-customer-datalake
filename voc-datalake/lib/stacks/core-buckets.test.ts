import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import {
  ABORT_MULTIPART_DAYS,
  ACCESS_LOGS_NONCURRENT_VERSION_DAYS,
  RAW_BUCKET_WORKSPACE_PREFIXES,
  APPEND_ONLY_PREFIXES,
  ENGINEERING_CACHE_EXPIRATION_DAYS,
  ENGINEERING_RUNS_PREFIX,
  ENGINEERING_WORKSPACE,
  RAW_LAYER_PREFIX,
  SILVER_HISTORY_PREFIX,
  SCRATCH_EXPIRATION_DAYS,
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
      website: WEBSITE_NONCURRENT_VERSION_DAYS,
      accessLogs: ACCESS_LOGS_NONCURRENT_VERSION_DAYS,
      abortMultipart: ABORT_MULTIPART_DAYS,
      scratch: SCRATCH_EXPIRATION_DAYS,
    }).toStrictEqual({ website: 30, accessLogs: 30, abortMultipart: 7, scratch: 2 });
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

  const SCRATCH_RULE = {
    Id: 'scratch-expiry', Status: 'Enabled', Prefix: 'scratch/', ExpirationInDays: SCRATCH_EXPIRATION_DAYS,
    NoncurrentVersionExpiration: { NoncurrentDays: SCRATCH_EXPIRATION_DAYS },
  };

  it('RawDataBucket keeps every version outside scratch/: no workspace noncurrent rule (deletes remove their versions)', () => {
    expect(versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules).toStrictEqual([
      { Id: 'abort-incomplete-uploads', Status: 'Enabled',
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_MULTIPART_DAYS } },
      { Id: 'remove-expired-delete-markers', Status: 'Enabled', ExpiredObjectDeleteMarker: true },
      SCRATCH_RULE,
    ]);
    expect(RAW_BUCKET_WORKSPACE_PREFIXES).toStrictEqual(
      ['avatars/', 'company-context/', 'engineering/', 'memory-imports/', 'projects/', 'prototypes/', 'scratch/']);
  });

  it.each(APPEND_ONLY_PREFIXES)('no raw-bucket lifecycle rule can expire anything under %s (kept forever)', (layer) => {
    const rules = versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules;
    const expiring = rules.filter((rule) => 'NoncurrentVersionExpiration' in rule || 'ExpirationInDays' in rule
      || 'ExpirationDate' in rule || 'Transitions' in rule || 'NoncurrentVersionTransitions' in rule);
    for (const rule of expiring) {
      const prefix = z.string().parse(rule['Prefix']);
      expect(prefix.startsWith(layer) || layer.startsWith(prefix), String(rule['Id'])).toBe(false);
    }
  });

  it('never expires current raw-data versions outside scratch/ (raw customer data is kept forever)', () => {
    const rules = versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules;
    expect(rules.filter((rule) => 'ExpirationInDays' in rule || 'ExpirationDate' in rule)).toStrictEqual([SCRATCH_RULE]);
  });
});

/**
 * With -c engineeringAgents=true only the repository caches expire; the runs' objects are kept until an expiry that
 * writes its AUDIT#delete row exists (TENETS.md D5); nothing else about the raw bucket changes.
 */
describe('VocCoreStack raw bucket with the engineering agents', () => {
  const RulesSchema = z.object({
    Properties: z.object({ LifecycleConfiguration: z.object({ Rules: z.array(z.record(z.string(), z.unknown())) }) }),
  });
  let rules: Record<string, unknown>[];
  beforeAll(() => {
    const found = Object.entries(synthCoreTemplate({ engineeringAgents: 'true' }).findResources('AWS::S3::Bucket'))
      .filter(([logicalId]) => logicalId.startsWith('RawDataBucket'));
    rules = RulesSchema.parse(itemAt(found, 0)[1]).Properties.LifecycleConfiguration.Rules;
  });

  it('expires only the caches, at 30 days with their noncurrent versions a day later; never the runs\' objects', () => {
    expect(ENGINEERING_CACHE_EXPIRATION_DAYS).toBe(30);
    expect(rules.filter((rule) => String(rule['Id']).startsWith('engineering-'))).toStrictEqual([
      { Id: 'engineering-cache-expiry', Status: 'Enabled', Prefix: 'engineering/cache/', ExpirationInDays: 30,
        NoncurrentVersionExpiration: { NoncurrentDays: 1 } },
    ]);
    const prefixes = rules.map((rule) => rule['Prefix']).filter((prefix) => typeof prefix === 'string');
    expect(prefixes.filter((prefix) => ENGINEERING_RUNS_PREFIX.startsWith(prefix) || prefix.startsWith(ENGINEERING_RUNS_PREFIX)))
      .toStrictEqual([]);
  });

  it.each(APPEND_ONLY_PREFIXES)('still expires nothing under %s', (layer) => {
    const prefixes = rules.map((rule) => rule['Prefix']).filter((prefix) => typeof prefix === 'string');
    expect(prefixes.filter((prefix) => prefix.startsWith(layer) || layer.startsWith(prefix))).toStrictEqual([]);
  });
});

/**
 * The engineering workspace bucket (lambda/engineering/workspace/): only with -c engineeringAgents=true; private,
 * KMS-encrypted, versioned and access-logged like the raw bucket; nothing in it expires (TENETS.md D5: an expiry
 * waits for one that writes its AUDIT#delete row).
 */
describe('VocCoreStack engineering workspace bucket', () => {
  const workspaceBuckets = (template: Template) => Object.entries(template.findResources('AWS::S3::Bucket'))
    .filter(([logicalId]) => logicalId.startsWith('EngineeringWorkspaceBucket'));

  it('is absent by default', () => {
    expect(workspaceBuckets(synthCoreTemplate())).toStrictEqual([]);
  });

  it('is private, on the stack key, versioned and logged; expires nothing, current or noncurrent', () => {
    const found = workspaceBuckets(synthCoreTemplate({ engineeringAgents: 'true' }));
    expect(found).toHaveLength(1);
    const props = z.looseObject({ Properties: z.record(z.string(), z.unknown()) }).parse(itemAt(found, 0)[1]).Properties;
    expect(props).toMatchObject({
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
      LoggingConfiguration: { LogFilePrefix: 'engineering-workspace-bucket/' },
    });
    const rules = z.object({ Rules: z.array(z.record(z.string(), z.unknown())) })
      .parse(props['LifecycleConfiguration']).Rules;
    // Only the no-data hygiene: abandoned multipart uploads and expired delete markers.
    expect(rules).toStrictEqual([
      { Id: 'abort-incomplete-uploads', Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } },
      { Id: 'remove-expired-delete-markers', Status: 'Enabled', ExpiredObjectDeleteMarker: true },
    ]);
  });

  it('refuses, for every principal, any write that could overwrite an object (no If-None-Match)', () => {
    const template = synthCoreTemplate({ engineeringAgents: 'true' });
    const policies = Object.values(template.findResources('AWS::S3::BucketPolicy'))
      .filter((policy) => JSON.stringify(policy.Properties?.Bucket).includes('EngineeringWorkspaceBucket'));
    const denies = z.array(z.looseObject({ Sid: z.string().optional() }))
      .parse(itemAt(policies, 0).Properties?.PolicyDocument?.Statement)
      .filter((statement) => statement.Sid === 'DenyWorkspaceWritesWithoutIfNoneMatch');
    expect(denies).toMatchObject([{
      Effect: 'Deny', Principal: { AWS: '*' }, Action: 's3:PutObject',
      Condition: { Null: { 's3:if-none-match': 'true' }, Bool: { 's3:ObjectCreationOperation': 'true' } },
    }]);
    expect(JSON.stringify(denies[0]?.['Resource'])).toContain('"/*"');
  });

  it('keeps the workspace key layout of lambda/engineering/workspace/layout.py and the one workspace of identity.py', () => {
    expect(ENGINEERING_WORKSPACE).toBe('default');
    const layout = readFileSync(join(__dirname, '../../lambda/engineering/workspace/layout.py'), 'utf8');
    expect(layout).toContain("f'ws/{_check(_WS, ws, \"workspace\")}/reports/");
    expect(layout).toContain("(parts[0], parts[2], parts[5]) != ('ws', 'runs', 'commits')");
    const identity = readFileSync(join(__dirname, '../../lambda/engineering/connectors/identity.py'), 'utf8');
    expect(identity).toMatch(/^WORKSPACE: Final = 'default'$/m);
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
    const resources = JSON.stringify(statement['Resource']);
    expect(APPEND_ONLY_PREFIXES.filter((prefix) => !resources.includes(`/${prefix}*`))).toStrictEqual([]);
  });

  it('covers exactly the append-only layers: raw/ (bronze) and silver/ (Silver history)', () => {
    expect(APPEND_ONLY_PREFIXES).toStrictEqual(['raw/', 'silver/']);
  });
});

/**
 * Every prefix a stack grants on the raw data bucket is either raw/ (no expiry) or a known workspace
 * prefix (RAW_BUCKET_WORKSPACE_PREFIXES). Read from the stack SOURCES (every
 * `rawDataBucket.grant*(…)` / `rawDataBucket.arnForObjects(…)` argument, string constants
 * resolved), so a new prefix is a deliberate addition to that list.
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

  it('names only raw/ or a known workspace prefix', () => {
    const known: readonly string[] = [RAW_LAYER_PREFIX, SILVER_HISTORY_PREFIX, ...RAW_BUCKET_WORKSPACE_PREFIXES];
    const tops = [...new Set(grantedPrefixes().map((prefix) => `${prefix.split('/')[0] ?? ''}/`))];
    expect(tops.filter((top) => !known.includes(top))).toStrictEqual([]);
  });
});
