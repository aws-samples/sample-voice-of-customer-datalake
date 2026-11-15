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
  ENGINEERING_CACHE_EXPIRATION_DAYS,
  ENGINEERING_WORKSPACE,
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
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_ACCOUNT, SYNTH_REGION, SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

/** The pseudo-parameters as the fixtures deploy them (core-stack-fixture.ts, processing-stack-fixture.ts). */
const PSEUDO: Readonly<Record<string, string>> = {
  'AWS::AccountId': SYNTH_ACCOUNT, 'AWS::Region': SYNTH_REGION, 'AWS::Partition': 'aws',
};

/** A template value of literals, pseudo-parameter Refs and Fn::Joins, as the string it deploys as. */
function resolved(value: unknown): string {
  if (typeof value === 'string') return value;
  const ref = z.object({ Ref: z.string() }).safeParse(value);
  if (ref.success) {
    const pseudo = PSEUDO[ref.data.Ref];
    if (pseudo === undefined) throw new Error(`not a pseudo-parameter: ${ref.data.Ref}`);
    return pseudo;
  }
  const [separator, parts] = z.object({ 'Fn::Join': z.tuple([z.string(), z.array(z.unknown())]) }).parse(value)['Fn::Join'];
  return parts.map(resolved).join(separator);
}

/** The one cache deny of the raw bucket's policy, with `protectData` as `protect` and the deployment `prefix`. */
function cacheDeny(protect: 'true' | 'false', prefix?: string): Record<string, unknown> {
  const statements = rawBucketStatements(synthCoreTemplate({ engineeringAgents: 'true', protectData: protect }, prefix))
    .filter((statement) => statement['Sid'] === 'DenyEngineeringCacheWritesButTheWriters');
  expect(statements).toHaveLength(1);
  return itemAt(statements, 0);
}

/** The principals the cache deny exempts (its `ArnNotEquals` on `aws:PrincipalArn`). */
function exempted(statement: Record<string, unknown>): unknown[] {
  return z.object({ ArnNotEquals: z.object({ 'aws:PrincipalArn': z.array(z.unknown()) }) })
    .parse(statement['Condition']).ArnNotEquals['aws:PrincipalArn'];
}

/** The ARN of the checkout cache writer's role as VocProcessingStack, with the deployment `prefix`, creates it. */
function writerRoleArn(prefix: string | undefined): string {
  const roles = Object.values(synthProcessingTemplate({ context: { engineeringAgents: 'true' }, deploymentPrefix: prefix })
    .findResources('AWS::IAM::Role'))
    .map((role) => role.Properties?.RoleName)
    .filter((name) => JSON.stringify(name ?? '').includes('voc-engineering-cache'));
  expect(roles).toHaveLength(1);
  return `arn:aws:iam::${SYNTH_ACCOUNT}:role/${resolved(roles[0])}`;
}

/**
 * The deny's exemption is the role the writer runs as, exactly: both stacks take its name from
 * core-buckets.ts engineeringCacheWriterRoleName, with the deployment's prefix or without one.
 */
describe.each([undefined, 'stg'])('the raw bucket\'s cache deny, deployment prefix %s', (prefix) => {
  it('exempts exactly the ARN of the writer\'s role VocProcessingStack creates (protectData on: nothing else)', () => {
    const expected = writerRoleArn(prefix);
    expect(exempted(cacheDeny('true', prefix)).map(resolved)).toStrictEqual([expected]);
    expect(expected).toMatch(prefix === undefined ? /:role\/voc-engineering-cache-/ : /:role\/stg-voc-engineering-cache-/);
  }, SYNTH_TIMEOUT_MS);
});

/** The raw data bucket's bucket-policy statements in `template`. */
function rawBucketStatements(template: Template): Record<string, unknown>[] {
  const policies = Object.values(template.findResources('AWS::S3::BucketPolicy'))
    .filter((policy) => JSON.stringify(policy.Properties?.Bucket).includes('RawDataBucket'));
  expect(policies).toHaveLength(1);
  return z.array(z.record(z.string(), z.unknown())).parse(itemAt(policies, 0).Properties?.PolicyDocument?.Statement);
}

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
      ['avatars/', 'company-context/', 'engineering/', 'memory-imports/', 'projects/', 'prototypes/', 'scratch/']);
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
    // Where the runtime wrote its runs' objects before voc-eng-workspace: no rule may expire them either.
    const oldRuns = 'engineering/runs/';
    expect(prefixes.filter((prefix) => oldRuns.startsWith(prefix) || prefix.startsWith(oldRuns)))
      .toStrictEqual([]);
  });

  it('lets no principal put or delete under engineering/cache/ but those its condition exempts', () => {
    const statement = cacheDeny('false');
    expect({ ...statement, Resource: undefined, Condition: undefined }).toStrictEqual({
      Sid: 'DenyEngineeringCacheWritesButTheWriters', Effect: 'Deny', Principal: { AWS: '*' },
      Action: ['s3:DeleteObject*', 's3:PutObject*'], Resource: undefined, Condition: undefined,
    });
    expect(JSON.stringify(statement['Resource'])).toContain('"/engineering/cache/*"');
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(statement['Condition']))).toStrictEqual(['ArnNotEquals']);
  });

  it('exempts, without protectData, the writer\'s role VocProcessingStack creates and the stack\'s auto-delete provider', () => {
    const [writer, autoDelete, ...others] = exempted(cacheDeny('false'));
    expect(resolved(writer)).toBe(writerRoleArn(undefined));
    expect(autoDelete).toStrictEqual({
      'Fn::GetAtt': [expect.stringMatching(/^CustomS3AutoDeleteObjectsCustomResourceProviderRole/), 'Arn'],
    });
    expect(others).toStrictEqual([]);
  }, SYNTH_TIMEOUT_MS);

  it('has no such deny without the engineering agents', () => {
    expect(rawBucketStatements(synthCoreTemplate())
      .filter((statement) => statement['Sid'] === 'DenyEngineeringCacheWritesButTheWriters')).toStrictEqual([]);
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
