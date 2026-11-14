import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import {
  ABORT_MULTIPART_DAYS,
  ACCESS_LOGS_NONCURRENT_VERSION_DAYS,
  EXPORT_EXPIRATION_DAYS,
  EXPORT_NONCURRENT_VERSION_DAYS,
  EXPORT_TAG_KEY,
  RAW_BUCKET_WORKSPACE_PREFIXES,
  APPEND_ONLY_PREFIXES,
  RAW_LAYER_PREFIX,
  SILVER_HISTORY_PREFIX,
  SCRATCH_EXPIRATION_DAYS,
  WEBSITE_NONCURRENT_VERSION_DAYS,
  WORKSPACE_DATA_PREFIX,
  WORKSPACE_EXPORTS_PREFIX,
  WORKSPACE_ID_PATTERN,
  WORKSPACE_RAW_LAYER_PREFIX,
  WORKSPACE_SILVER_HISTORY_PREFIX,
  WORKSPACE_MEMORY_IMPORTS_PREFIX,
} from './core-buckets';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { itemAt } from '../test-support/guards';

/** One workspace id in an IAM pattern, spelt out: `ws_` and 26 `?` (29 characters, lambda/shared/workspace_ids.py). */
const ONE_WORKSPACE = 'ws_??????????????????????????';

describe('the workspace id in an IAM pattern', () => {
  it('is exactly one id: ws_ and one ? per ULID character, never *', () => {
    expect(WORKSPACE_ID_PATTERN).toBe(ONE_WORKSPACE);
    expect(ONE_WORKSPACE).toHaveLength(29);
    // IAM's `?` is one character of any kind: the pattern matches a real id, and nothing longer or shorter.
    const asRegExp = new RegExp(`^${WORKSPACE_ID_PATTERN.replaceAll('?', '.')}$`);
    const ids = ['ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D', 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/x'];
    expect(ids.map((id) => asRegExp.test(id))).toStrictEqual([true, false, false]);
  });
});

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
  // A workspace export's objects (docs/multi-workspace.md "Export and delete"), matched by their tag alone: the
  // bucket policy refuses that tag outside `ws/{ws}/exports/` (DenyExportTagOutsideExports, below), so the rule
  // never reaches raw/ or silver/ (D1). A deliberate change of this suite: until phase 4 only scratch/ expired.
  const EXPORT_RULE = {
    Id: 'export-expiry', Status: 'Enabled', TagFilters: [{ Key: EXPORT_TAG_KEY, Value: 'true' }],
    ExpirationInDays: EXPORT_EXPIRATION_DAYS, NoncurrentVersionExpiration: { NoncurrentDays: EXPORT_NONCURRENT_VERSION_DAYS },
  };

  it('pins the export windows: 10 days for an export (its link window is 7), 1 day for its old version', () => {
    expect([EXPORT_TAG_KEY, EXPORT_EXPIRATION_DAYS, EXPORT_NONCURRENT_VERSION_DAYS]).toStrictEqual(['voc-export', 10, 1]);
    expect(WORKSPACE_EXPORTS_PREFIX).toBe(`ws/${ONE_WORKSPACE}/exports/`);
  });

  it('RawDataBucket keeps every version outside scratch/ and the tagged exports: no workspace noncurrent rule (deletes remove their versions)', () => {
    expect(versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules).toStrictEqual([
      { Id: 'abort-incomplete-uploads', Status: 'Enabled',
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_MULTIPART_DAYS } },
      { Id: 'remove-expired-delete-markers', Status: 'Enabled', ExpiredObjectDeleteMarker: true },
      SCRATCH_RULE,
      EXPORT_RULE,
    ]);
    expect(RAW_BUCKET_WORKSPACE_PREFIXES).toStrictEqual(
      ['avatars/', 'company-context/', 'memory-imports/', 'projects/', 'prototypes/', 'scratch/']);
  });

  it('every expiring rule is a prefix rule or the export tag rule, never a tag rule of any other tag', () => {
    const rules = versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules;
    const tagged = rules.filter((rule) => 'TagFilters' in rule);
    expect(tagged).toStrictEqual([EXPORT_RULE]);
    expect(tagged.every((rule) => !('Prefix' in rule))).toBe(true);
  });

  it.each(APPEND_ONLY_PREFIXES)('no raw-bucket lifecycle rule can expire anything under %s (kept forever)', (layer) => {
    const rules = versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules;
    const expiring = rules.filter((rule) => 'NoncurrentVersionExpiration' in rule || 'ExpirationInDays' in rule
      || 'ExpirationDate' in rule || 'Transitions' in rule || 'NoncurrentVersionTransitions' in rule);
    // A lifecycle prefix is literal: a workspace layer (`ws/{ws}/raw/`) is reached by any rule on `ws/` or below it.
    // The export tag rule has no prefix: the bucket policy keeps its tag off every append-only layer (below).
    const literal = layer.split('*')[0] ?? layer;
    for (const rule of expiring.filter((candidate) => candidate['Id'] !== EXPORT_RULE.Id)) {
      const prefix = z.string().parse(rule['Prefix']);
      expect(prefix.startsWith(literal) || literal.startsWith(prefix), String(rule['Id'])).toBe(false);
    }
  });

  it('no raw-bucket lifecycle rule reaches the workspaces\' root ws/ (their raw/ and silver/ are kept forever)', () => {
    const rules = versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules;
    const prefixed = rules.filter((rule) => typeof rule['Prefix'] === 'string')
      .map((rule) => z.string().parse(rule['Prefix']));
    expect(prefixed.filter((prefix) => prefix.startsWith(WORKSPACE_DATA_PREFIX) || WORKSPACE_DATA_PREFIX.startsWith(prefix)))
      .toStrictEqual([]);
    expect(prefixed).toStrictEqual(['scratch/']);
  });

  it('never expires current raw-data versions outside scratch/ and the tagged exports (raw customer data is kept forever)', () => {
    const rules = versionedBucket('RawDataBucket').Properties.LifecycleConfiguration.Rules;
    expect(rules.filter((rule) => 'ExpirationInDays' in rule || 'ExpirationDate' in rule))
      .toStrictEqual([SCRATCH_RULE, EXPORT_RULE]);
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
    // Each workspace's layers by name too: the plugin ingestors write ws/{ws}/raw/ (D1 holds per workspace).
    const covered = [...APPEND_ONLY_PREFIXES.map((prefix) => `/${prefix}*`), `/ws/${ONE_WORKSPACE}/raw/*`, `/ws/${ONE_WORKSPACE}/silver/*`];
    expect(covered.filter((resource) => !resources.includes(resource))).toStrictEqual([]);
  });

  /** The raw bucket policy's one DenyExportTagOutsideExports statement. */
  function exportTagDeny(): z.infer<typeof StatementSchema> {
    const policies = Object.values(synthCoreTemplate().findResources('AWS::S3::BucketPolicy'))
      .map((resource) => PolicySchema.parse(resource).Properties)
      .filter((policy) => policy.Bucket.Ref.startsWith('RawDataBucket'));
    const statements = itemAt(policies, 0).PolicyDocument.Statement
      .filter((statement) => statement.Sid === 'DenyExportTagOutsideExports');
    expect(statements).toHaveLength(1);
    return itemAt(statements, 0);
  }

  it('denies the export tag on any key outside a workspace\'s exports, to everyone', () => {
    const statement = exportTagDeny();
    expect({ ...statement, NotResource: undefined }).toStrictEqual({
      Sid: 'DenyExportTagOutsideExports',
      Effect: 'Deny',
      Principal: { AWS: '*' },
      Action: ['s3:PutObject', 's3:PutObjectTagging'],
      Condition: { 'ForAnyValue:StringEquals': { 's3:RequestObjectTagKeys': EXPORT_TAG_KEY } },
      NotResource: undefined,
    });
  });

  it('denies a copy of any workspace\'s export object to a key outside one workspace\'s exports (it would carry the tag)', () => {
    const policies = Object.values(synthCoreTemplate().findResources('AWS::S3::BucketPolicy'))
      .map((resource) => PolicySchema.parse(resource).Properties)
      .filter((policy) => policy.Bucket.Ref.startsWith('RawDataBucket'));
    const [statement] = itemAt(policies, 0).PolicyDocument.Statement
      .filter((candidate) => candidate.Sid === 'DenyExportCopiesOutsideExports');
    expect({ ...statement, NotResource: undefined }).toStrictEqual({
      Sid: 'DenyExportCopiesOutsideExports', Effect: 'Deny', Principal: { AWS: '*' }, Action: 's3:PutObject',
      Condition: { StringLike: { 's3:x-amz-copy-source': [
        `*ws/${ONE_WORKSPACE}/exports/*`, `*ws%2F${ONE_WORKSPACE}%2Fexports%2F*`, `*ws%2f${ONE_WORKSPACE}%2fexports%2f*`,
      ] } }, NotResource: undefined,
    });
    expect(JSON.stringify(statement?.['NotResource'])).toContain(`/ws/${ONE_WORKSPACE}/exports/*`);
  });

  it('excepts exactly one workspace id\'s exports from that Deny, never ws/*/exports/*', () => {
    const statement = exportTagDeny();
    // One workspace id in the exception, never `ws/*/exports/*` (IAM's `*` would also match ws/{ws}/raw/exports/…).
    const notResource = JSON.stringify(statement['NotResource']);
    expect(notResource).toContain(`/ws/${ONE_WORKSPACE}/exports/*`);
    expect(notResource).not.toContain('/ws/*/');
    expect(statement).not.toHaveProperty('Resource');
  });

  it('covers exactly the append-only layers: raw/ (bronze) and silver/ (Silver history), at the root and per workspace', () => {
    expect(APPEND_ONLY_PREFIXES).toStrictEqual(['raw/', 'silver/', `ws/${ONE_WORKSPACE}/raw/`, `ws/${ONE_WORKSPACE}/silver/`]);
    expect([WORKSPACE_RAW_LAYER_PREFIX, WORKSPACE_SILVER_HISTORY_PREFIX])
      .toStrictEqual([`${WORKSPACE_DATA_PREFIX}${WORKSPACE_ID_PATTERN}/${RAW_LAYER_PREFIX}`, `${WORKSPACE_DATA_PREFIX}${WORKSPACE_ID_PATTERN}/${SILVER_HISTORY_PREFIX}`]);
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
  // Built from WORKSPACE_ID_PATTERN (a template, which the literal scan below cannot read): its value as imported.
  const constants = new Map<string, string>([
    ['WORKSPACE_RAW_LAYER_PREFIX', WORKSPACE_RAW_LAYER_PREFIX],
    ['WORKSPACE_SILVER_HISTORY_PREFIX', WORKSPACE_SILVER_HISTORY_PREFIX],
    ['WORKSPACE_MEMORY_IMPORTS_PREFIX', WORKSPACE_MEMORY_IMPORTS_PREFIX],
    ['WORKSPACE_EXPORTS_PREFIX', WORKSPACE_EXPORTS_PREFIX],
  ]);
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
    const known: readonly string[] = [
      RAW_LAYER_PREFIX, SILVER_HISTORY_PREFIX, WORKSPACE_DATA_PREFIX, ...RAW_BUCKET_WORKSPACE_PREFIXES,
    ];
    const tops = [...new Set(grantedPrefixes().map((prefix) => `${prefix.split('/')[0] ?? ''}/`))];
    expect(tops.filter((top) => !known.includes(top))).toStrictEqual([]);
  });
});
