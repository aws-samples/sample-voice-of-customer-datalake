/**
 * VocIngestionStack: the S3-import staging bucket's data-protection settings.
 *
 * Versioning is on (AWS S3 security best practice: recover from an accidental
 * overwrite or delete), and the lifecycle rules that keep it cheap on a staging
 * bucket are pinned here — dropping either half silently turns versioning into
 * unbounded storage growth, or turns the bucket back into one where a delete is
 * unrecoverable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import {
  IMPORT_ABORT_MULTIPART_DAYS,
  IMPORT_NONCURRENT_VERSION_DAYS,
  IMPORT_STAGED_EXPIRATION_DAYS,
  S3_IMPORT_BUCKET_ENV,
  SCHEDULE_TARGET_MAX_EVENT_AGE,
  SCHEDULE_TARGET_RETRY_ATTEMPTS,
} from './ingestion-stack';
import { itemAt } from '../test-support/guards';
import { capitalize } from '../plugin-loader';
import { synthIngestionStacks, synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { SYNTH_ACCOUNT, SYNTH_REGION } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';


const BucketSchema = z.object({
  Properties: z.object({
    VersioningConfiguration: z.object({ Status: z.string() }),
    PublicAccessBlockConfiguration: z.object({
      BlockPublicAcls: z.literal(true),
      BlockPublicPolicy: z.literal(true),
      IgnorePublicAcls: z.literal(true),
      RestrictPublicBuckets: z.literal(true),
    }),
    BucketEncryption: z.object({
      ServerSideEncryptionConfiguration: z.array(z.object({
        ServerSideEncryptionByDefault: z.object({ SSEAlgorithm: z.string() }),
      })),
    }),
    LifecycleConfiguration: z.object({
      Rules: z.array(z.object({ Id: z.string() }).loose()),
    }),
  }),
});

function importBucket(template: Template): z.infer<typeof BucketSchema> {
  const buckets = Object.entries(template.findResources('AWS::S3::Bucket'))
    .filter(([logicalId]) => logicalId.startsWith('S3ImportBucket'));
  expect(buckets, 'expected exactly one S3ImportBucket').toHaveLength(1);
  return BucketSchema.parse(itemAt(buckets, 0)[1]);
}

describe('VocIngestionStack S3 import bucket', () => {
  let template: Template;
  let bucket: z.infer<typeof BucketSchema>;

  beforeAll(() => {
    template = synthIngestionTemplate();
    bucket = importBucket(template);
  });

  it('is versioned, KMS-encrypted and blocks all public access', () => {
    expect(bucket.Properties.VersioningConfiguration.Status).toBe('Enabled');
    expect(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration
      .map((rule) => rule.ServerSideEncryptionByDefault.SSEAlgorithm)).toStrictEqual(['aws:kms']);
  });

  it('bounds versioning cost: noncurrent versions expire and abandoned uploads abort', () => {
    expect(IMPORT_NONCURRENT_VERSION_DAYS).toBe(7);
    expect(IMPORT_STAGED_EXPIRATION_DAYS).toBe(90);
    expect(IMPORT_ABORT_MULTIPART_DAYS).toBe(1);
    expect(bucket.Properties.LifecycleConfiguration.Rules).toStrictEqual(expect.arrayContaining([
      {
        Id: 'staging-version-hygiene',
        Status: 'Enabled',
        ExpirationInDays: IMPORT_STAGED_EXPIRATION_DAYS,
        NoncurrentVersionExpiration: { NoncurrentDays: IMPORT_NONCURRENT_VERSION_DAYS },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: IMPORT_ABORT_MULTIPART_DAYS },
      },
      { Id: 'remove-expired-delete-markers', Status: 'Enabled', ExpiredObjectDeleteMarker: true },
      expect.objectContaining({ Id: 'move-processed-to-glacier', Prefix: 'processed/' }),
    ]));
  });

  it('denies non-TLS access in its bucket policy', () => {
    expect(() => template.hasResourceProperties('AWS::S3::BucketPolicy', {
      Bucket: { Ref: Match.stringLikeRegexp('^S3ImportBucket') },
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    })).not.toThrow();
  });

  it('still empties itself on stack deletion, versions included', () => {
    // autoDeleteObjects' custom resource deletes every object VERSION, so
    // versioning does not leave a DESTROY bucket undeletable.
    expect(() => template.resourceCountIs('Custom::S3AutoDeleteObjects', 1)).not.toThrow();
  });
});

// ── Scheduled ingestion dead-letter queue (#253) ─────────────────────────────
// EventBridge drops an event it cannot deliver (throttled / unreachable ingestor)
// once retries or max age run out — silently, unless the target has a DLQ.

const GetAttSchema = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) });
const RuleSchema = z.object({
  Properties: z.object({
    Targets: z.array(z.object({
      DeadLetterConfig: z.object({ Arn: GetAttSchema }).optional(),
      RetryPolicy: z.object({
        MaximumRetryAttempts: z.number(),
        MaximumEventAgeInSeconds: z.number(),
      }).optional(),
    })),
  }),
});
const QueueSchema = z.object({
  Properties: z.object({
    KmsMasterKeyId: z.unknown(),
  }),
});
/** `{ 'Fn::Join': ['', parts] }` — a name built from the account/region pseudo parameters. */
const JoinSchema = z.object({ 'Fn::Join': z.tuple([z.literal(''), z.array(z.unknown())]) });
const RefSchema = z.object({ Ref: z.string() });

/** A literal or `Fn::Join` as one string, each `{Ref: X}` rendered `${X}`. */
function flattenJoin(value: unknown): string {
  if (typeof value === 'string') return value;
  return JoinSchema.parse(value)['Fn::Join'][1]
    .map((part) => (typeof part === 'string' ? part : `\${${RefSchema.parse(part).Ref}}`))
    .join('');
}

function logicalIdsStartingWith(template: Template, type: string, prefix: string): string[] {
  return Object.keys(template.findResources(type)).filter((id) => id.startsWith(prefix));
}

describe('VocIngestionStack scheduled ingestion dead-letter queue', () => {
  // Two scheduled plugins: both rules must share the ONE queue.
  let template: Template;
  beforeAll(() => {
    template = synthIngestionTemplate(['webscraper', 'app_reviews_ios']);
  });

  it('gives every schedule target the DLQ, bounded retries and a max event age', () => {
    const rules = Object.values(template.findResources('AWS::Events::Rule'))
      .map((resource) => RuleSchema.parse(resource).Properties);
    expect(rules, 'expected one schedule rule per scheduled plugin').toHaveLength(2);
    const dlqIds = logicalIdsStartingWith(template, 'AWS::SQS::Queue', 'IngestScheduleDLQ');
    expect(dlqIds).toHaveLength(1);

    for (const target of rules.flatMap((rule) => rule.Targets)) {
      expect(target.DeadLetterConfig?.Arn['Fn::GetAtt']).toStrictEqual([itemAt(dlqIds, 0), 'Arn']);
      expect(target.RetryPolicy).toStrictEqual({
        MaximumRetryAttempts: SCHEDULE_TARGET_RETRY_ATTEMPTS,
        MaximumEventAgeInSeconds: SCHEDULE_TARGET_MAX_EVENT_AGE.toSeconds(),
      });
    }
  });

  /** The key reference (`KmsMasterKeyId`) of the one queue whose logical id starts with `prefix`. */
  const queueKeyRef = (prefix: string): unknown => QueueSchema.parse(template.findResources('AWS::SQS::Queue')[
    itemAt(logicalIdsStartingWith(template, 'AWS::SQS::Queue', prefix), 0)
  ]).Properties.KmsMasterKeyId;

  it('encrypts the DLQ with the Core key and creates no key of its own', () => {
    // One customer-managed key per deployment (tenet 7 baseline): the EventBridge grant
    // lives on the Core key's policy (dlq-alarms.test.ts pins that statement and its queue ARN).
    // Positive check: the DLQ names the very key the processing queue (Core key) uses, so dropping
    // `encryptionMasterKey` or switching to SQS-managed SSE fails here.
    const coreKeyRef = queueKeyRef('ProcessingQueue');
    expect(coreKeyRef).toStrictEqual({ 'Fn::ImportValue': expect.stringContaining('Key') });
    expect(queueKeyRef('IngestScheduleDLQ')).toStrictEqual(coreKeyRef);
    expect(Object.keys(template.findResources('AWS::KMS::Key'))).toStrictEqual([]);
  });

  it('lets only the schedule rules send to the DLQ, over TLS', () => {
    expect(() => template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      Queues: [{ Ref: Match.stringLikeRegexp('^IngestScheduleDLQ') }],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
          Match.objectLike({
            Effect: 'Allow',
            Action: 'sqs:SendMessage',
            Principal: { Service: 'events.amazonaws.com' },
            Condition: { ArnEquals: { 'aws:SourceArn': Match.anyValue() } },
          }),
        ]),
      },
    })).not.toThrow();
  });

  it('creates no DLQ when no plugin is scheduled', () => {
    const bare = synthIngestionTemplate();
    expect(logicalIdsStartingWith(bare, 'AWS::SQS::Queue', 'IngestScheduleDLQ')).toHaveLength(0);
  });
});

// ── The scheduled tick fans out over the workspaces (docs/multi-workspace.md) ───
// One rule per plugin fires for every workspace: the ingestor claims the tick in
// voc-idempotency (ingestor#fanout#{plugin}#{event id}, so a retried delivery fans
// out no second time), reads the workspaces that enabled it (voc-workspaces,
// PLUGIN#{plugin}) and invokes its OWN function once per workspace
// (plugins/_shared/base_ingestor.py fan_out_once), then runs its deployment-wide run.
// So a scheduled role may put only its own claim keys, Query only the PLUGIN#
// partitions and invoke only its own function, never on the shared role. A
// workspace's tripped breaker stops that workspace's runs and disables no rule; a
// deployment-wide trip still disables the plugin's own rule (and with it every
// workspace's scheduled runs), so each scheduled role keeps events:DisableRule on
// exactly that rule.

const ScheduledRuleSchema = z.object({
  Properties: z.object({
    Name: z.unknown(),
    Targets: z.array(z.object({ Arn: GetAttSchema })),
  }),
});
const IngestorFunctionSchema = z.object({
  Properties: z.object({
    Role: GetAttSchema,
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
  }),
});
const PolicyStatementSchema = z.object({
  Effect: z.string().optional(),
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
  Condition: z.unknown().optional(),
});
const IamPolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(RefSchema),
    PolicyDocument: z.object({ Statement: z.array(PolicyStatementSchema) }),
  }),
});

/** One workspace id in an IAM pattern: `ws_` and one `?` per ULID character (26), never `*` (it crosses `/` and `#`). */
const ONE_WORKSPACE = 'ws_??????????????????????????';

const LeadingKeysConditionSchema = z.object({
  'ForAllValues:StringLike': z.object({ 'dynamodb:LeadingKeys': z.union([z.string(), z.array(z.string())]) }).strict(),
}).strict();

/** The `dynamodb:LeadingKeys` patterns of a statement's only condition (a list; undefined when it has none). */
function leadingKeys(condition: unknown): string[] | undefined {
  if (condition === undefined) return undefined;
  return [LeadingKeysConditionSchema.parse(condition)['ForAllValues:StringLike']['dynamodb:LeadingKeys']].flat();
}

/** Every Allow statement naming `action`, with the role(s) its policy is attached to (the audit-row Denies left out). */
function grantsOf(template: Template, action: string): { roles: string[]; resource: unknown; condition: unknown }[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap((resource) => {
    const policy = IamPolicySchema.parse(resource).Properties;
    return policy.PolicyDocument.Statement
      .filter((statement) => statement.Effect !== 'Deny' && [statement.Action].flat().includes(action))
      .map((statement) => ({
        roles: policy.Roles.map((role) => role.Ref), resource: statement.Resource, condition: statement.Condition,
      }));
  });
}

describe('VocIngestionStack scheduled tick fan-out grants', () => {
  // Two scheduled plugins and one unscheduled one.
  let template: Template;
  beforeAll(() => {
    template = synthIngestionTemplate(['webscraper', 'app_reviews_ios', 's3_import']);
  });

  const functionResource = (logicalId: string) =>
    IngestorFunctionSchema.parse(template.findResources('AWS::Lambda::Function')[logicalId]).Properties;
  const FunctionNameSchema = z.object({ Properties: z.object({ FunctionName: z.unknown() }) });

  /** Per schedule rule: the ingestor it invokes, that ingestor's name, env and role. */
  const scheduledIngestors = () => Object.values(template.findResources('AWS::Events::Rule'))
    .map((resource) => {
      const rule = ScheduledRuleSchema.parse(resource).Properties;
      const [functionId] = itemAt(rule.Targets, 0).Arn['Fn::GetAtt'];
      const fn = functionResource(functionId);
      const name = FunctionNameSchema.parse(template.findResources('AWS::Lambda::Function')[functionId]);
      return {
        ruleName: flattenJoin(rule.Name),
        functionName: flattenJoin(name.Properties.FunctionName),
        env: fn.Environment.Variables,
        roleId: fn.Role['Fn::GetAtt'][0],
      };
    });
  const s3ImportIngestor = () => {
    const unscheduled = Object.keys(template.findResources('AWS::Lambda::Function'))
      .filter((id) => id.startsWith(`Ingestor${capitalize('s3_import')}`));
    expect(unscheduled).toHaveLength(1);
    return functionResource(itemAt(unscheduled, 0));
  };

  it('hands each scheduled ingestor voc-workspaces, voc-idempotency and its own schedule rule', () => {
    const scheduled = scheduledIngestors();
    expect(scheduled).toHaveLength(2);
    for (const { env, ruleName } of scheduled) {
      expect({
        workspaces: env['WORKSPACES_TABLE'], idempotency: env['IDEMPOTENCY_TABLE'],
        rule: flattenJoin(env['INGEST_SCHEDULE_RULE_NAME']),
      }).toStrictEqual({
        workspaces: { 'Fn::ImportValue': expect.stringContaining('Workspaces') },
        idempotency: { 'Fn::ImportValue': expect.stringContaining('Idempotency') },
        rule: ruleName,
      });
    }
    const unscheduled = Object.keys(s3ImportIngestor().Environment.Variables);
    expect(unscheduled.filter((name) => ['WORKSPACES_TABLE', 'IDEMPOTENCY_TABLE', 'INGEST_SCHEDULE_RULE_NAME']
      .includes(name))).toStrictEqual([]);
  });

  it('lets each scheduled role put only its own plugin\'s tick claims in voc-idempotency, and nothing else there', () => {
    const scheduled = scheduledIngestors();
    const onIdempotency = (action: string) => grantsOf(template, action)
      .filter((grant) => JSON.stringify(grant.resource).includes('Idempotency'));
    expect(onIdempotency('dynamodb:PutItem').map((grant) => ({ roles: grant.roles, partitions: leadingKeys(grant.condition) })))
      .toStrictEqual(scheduled.map(({ roleId, env }) => ({
        roles: [roleId], partitions: [`ingestor#fanout#${String(env['SOURCE_PLATFORM'])}#*`],
      })));
    for (const action of ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query']) {
      expect(onIdempotency(action), action).toStrictEqual([]);
    }
  });

  it('lets each scheduled role Query voc-workspaces for its own plugin\'s PLUGIN# partition only, on its own role', () => {
    const scheduled = scheduledIngestors();
    const queries = grantsOf(template, 'dynamodb:Query')
      .filter((grant) => JSON.stringify(grant.resource).includes('Workspaces'));
    expect(new Set(scheduled.map((s) => s.roleId)).size, 'one role per scheduled ingestor').toBe(scheduled.length);
    expect(scheduled.map(({ roleId }) => queries.filter((grant) => grant.roles.includes(roleId))
      .map((grant) => ({ roles: grant.roles, partitions: leadingKeys(grant.condition) }))))
      .toStrictEqual(scheduled.map(({ roleId, env }) => [{
        roles: [roleId], partitions: [`PLUGIN#${String(env['SOURCE_PLATFORM'])}`],
      }]));
    expect(queries).toHaveLength(scheduled.length);
  });

  it('lets each scheduled role invoke exactly its own function, and the unscheduled one nothing', () => {
    const invokes = grantsOf(template, 'lambda:InvokeFunction');
    const scheduled = scheduledIngestors();
    expect(scheduled.map(({ roleId }) => invokes.filter((grant) => grant.roles.includes(roleId))
      .map((grant) => ({ roles: grant.roles, resource: flattenJoin(grant.resource) }))))
      .toStrictEqual(scheduled.map(({ roleId, functionName }) => [{
        roles: [roleId], resource: `arn:aws:lambda:${SYNTH_REGION}:${SYNTH_ACCOUNT}:function:${functionName}`,
      }]));
    const [roleId] = s3ImportIngestor().Role['Fn::GetAtt'];
    expect(invokes.filter((grant) => grant.roles.includes(roleId))).toStrictEqual([]);
    expect(grantsOf(template, 'dynamodb:Query').filter((grant) => grant.roles.includes(roleId)
      && JSON.stringify(grant.resource).includes('Workspaces'))).toStrictEqual([]);
  });

  it('grants each scheduled ingestor DisableRule on exactly its own rule ARN, on its own role, and no other', () => {
    // A deployment-wide run's breaker disables the plugin's own schedule (plugins/_shared/circuit_breaker.py); a
    // grant on the shared role, or a wildcard, would let a plugin switch off a sibling's ingestion.
    const grants = grantsOf(template, 'events:DisableRule');
    const scheduled = scheduledIngestors();
    expect(grants.map((grant) => ({ roles: grant.roles, resource: flattenJoin(grant.resource) })))
      .toStrictEqual(scheduled.map(({ roleId, ruleName }) => ({
        roles: [roleId], resource: `arn:aws:events:${SYNTH_REGION}:${SYNTH_ACCOUNT}:rule/${ruleName}`,
      })));
    const [roleId] = s3ImportIngestor().Role['Fn::GetAtt'];
    expect(grants.filter((grant) => grant.roles.includes(roleId))).toStrictEqual([]);
  });
});

// ── Both runs' credentials and bronze layers (docs/multi-workspace.md) ───
// A run in a workspace reads its own plugin's `voc/ws/{ws}/credentials/{plugin}` (decision 19) for the workspace its
// event names and writes under ws/{ws}/raw/; a deployment-wide run (an event naming none) reads the shared secret and
// writes under raw/, as before.
describe('VocIngestionStack ingestor secrets and raw writes', () => {
  const PLUGINS = ['webscraper', 'app_reviews_ios', 's3_import'];
  let template: Template;
  beforeAll(() => {
    template = synthIngestionTemplate(PLUGINS);
  });

  const ingestorFunctions = () => Object.entries(template.findResources('AWS::Lambda::Function'))
    .filter(([id]) => id.startsWith('Ingestor'))
    .map(([, resource]) => IngestorFunctionSchema.parse(resource).Properties);

  /** Each ingestor role and the plugins whose functions run as it (the shared role may serve several). */
  const pluginsByRole = (): Map<string, string[]> => {
    const functions = Object.entries(template.findResources('AWS::Lambda::Function'));
    const byRole = new Map<string, string[]>();
    for (const plugin of PLUGINS) {
      const found = functions.find(([id]) => id.startsWith(`Ingestor${capitalize(plugin)}`));
      expect(found, `no ingestor for ${plugin}`).toBeDefined();
      const role = IngestorFunctionSchema.parse(found?.[1]).Properties.Role['Fn::GetAtt'][0];
      byRole.set(role, [...(byRole.get(role) ?? []), plugin]);
    }
    return byRole;
  };
  const parameterArn = (plugin: string) =>
    `arn:aws:ssm:${SYNTH_REGION}:${SYNTH_ACCOUNT}:parameter/voc/ws/${ONE_WORKSPACE}/credentials/${plugin}`;
  const rendered = (resource: unknown): string[] => [resource].flat().map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  const KeyThroughSsmSchema = z.object({
    StringEquals: z.object({ 'kms:ViaService': z.string() }).strict(),
    StringLike: z.object({ 'kms:EncryptionContext:PARAMETER_ARN': z.union([z.string(), z.array(z.string())]) }).strict(),
  }).strict();

  it('names the workspace parameter prefix and the shared secret on every ingestor', () => {
    const functions = ingestorFunctions();
    expect(functions).toHaveLength(3);
    for (const fn of functions) {
      expect(fn.Environment.Variables['WORKSPACE_PARAMETER_PREFIX']).toBe('/voc/ws');
      expect(fn.Environment.Variables).not.toHaveProperty('WORKSPACE_SECRET_PREFIX');
      expect(fn.Environment.Variables['SECRETS_ARN']).toStrictEqual({ Ref: expect.stringMatching(/^VocApiSecrets/) });
    }
  });

  /** What `role` may read in SSM and decrypt through it: the parameter ARNs and the key conditions' ARNs and services. */
  const ssmReachOf = (role: string) => {
    const decrypts = grantsOf(template, 'kms:Decrypt')
      .filter((grant) => grant.roles.includes(role) && JSON.stringify(grant.condition ?? {}).includes('kms:ViaService'))
      .map((grant) => KeyThroughSsmSchema.parse(grant.condition));
    return {
      reads: grantsOf(template, 'ssm:GetParameter').filter((grant) => grant.roles.includes(role))
        .flatMap((grant) => rendered(grant.resource)).sort(byCodeUnit),
      decrypts: decrypts.flatMap((condition) => [condition.StringLike['kms:EncryptionContext:PARAMETER_ARN']].flat())
        .sort(byCodeUnit),
      services: [...new Set(decrypts.map((condition) => condition.StringEquals['kms:ViaService']))],
    };
  };

  it("lets each ingestor role read only its own plugins' credentials parameters, of one workspace id", () => {
    const byRole = pluginsByRole();
    expect([...byRole.values()].flat().sort(byCodeUnit)).toStrictEqual([...PLUGINS].sort(byCodeUnit));
    // Per role: GetParameter and kms:Decrypt (through SSM only) on exactly its plugins' names.
    expect(new Map([...byRole].map(([role]) => [role, ssmReachOf(role)]))).toStrictEqual(new Map([...byRole]
      .map(([role, plugins]) => {
        const arns = plugins.map((plugin) => parameterArn(plugin)).sort(byCodeUnit);
        return [role, { reads: arns, decrypts: arns, services: [`ssm.${SYNTH_REGION}.amazonaws.com`] }];
      })));
  });

  it('gives no ingestor role a write, a listing or a delete of a parameter', () => {
    const roleIds = new Set(pluginsByRole().keys());
    const touching = ['ssm:PutParameter', 'ssm:GetParametersByPath', 'ssm:DeleteParameter', 'kms:Encrypt']
      .flatMap((action) => grantsOf(template, action))
      .filter((grant) => grant.roles.some((role) => roleIds.has(role)) && JSON.stringify(grant).includes(':parameter/'));
    expect(touching).toStrictEqual([]);
  });

  it('lets every ingestor role read the shared secret and no workspace secret, and write no secret', () => {
    const roleIds = new Set(ingestorFunctions().map((fn) => fn.Role['Fn::GetAtt'][0]));
    const reads = grantsOf(template, 'secretsmanager:GetSecretValue')
      .filter((grant) => grant.roles.some((role) => roleIds.has(role)))
      .map((grant) => JSON.stringify(grant.resource));
    expect(reads.filter((resource) => resource.includes('VocApiSecrets'))).toHaveLength(roleIds.size);
    expect(reads.filter((resource) => !resource.includes('VocApiSecrets'))).toStrictEqual([]);
    expect(reads.some((resource) => resource.includes('voc/ws'))).toBe(false);
    for (const action of ['secretsmanager:PutSecretValue', 'secretsmanager:CreateSecret']) {
      expect(grantsOf(template, action).filter((grant) => grant.roles.some((role) => roleIds.has(role)))).toStrictEqual([]);
    }
  });

  it('lets every ingestor role delete only its breaker rows in voc-aggregates, deployment-wide and per workspace', () => {
    const roleIds = new Set(ingestorFunctions().map((fn) => fn.Role['Fn::GetAtt'][0]));
    const deletes = grantsOf(template, 'dynamodb:DeleteItem')
      .filter((grant) => grant.roles.some((role) => roleIds.has(role)) && JSON.stringify(grant.resource).includes('Aggregates'));
    expect(deletes).toHaveLength(roleIds.size);
    expect(deletes.map((grant) => leadingKeys(grant.condition)))
      .toStrictEqual(deletes.map(() => ['CIRCUIT#*', `WS#${ONE_WORKSPACE}#CIRCUIT#*`]));
  });

  it('lets every ingestor role put raw objects only under raw/ and ws/{one id}/raw/ (no read, no delete)', () => {
    const roleIds = new Set(ingestorFunctions().map((fn) => fn.Role['Fn::GetAtt'][0]));
    const rawGrants = (action: string) => grantsOf(template, action)
      .filter((grant) => grant.roles.some((role) => roleIds.has(role)) && JSON.stringify(grant.resource).includes('RawData'));
    // One statement per role (the two prefixes folded into one by CDK's policy minimization).
    const puts = rawGrants('s3:PutObject').map((grant) => JSON.stringify(grant.resource));
    expect(puts).toHaveLength(roleIds.size);
    const workspaceRaw = `/ws/${ONE_WORKSPACE}/raw/*`;
    for (const resource of puts) {
      expect([resource.includes(workspaceRaw), resource.includes('"/raw/*"')]).toStrictEqual([true, true]);
      expect(resource.split(workspaceRaw).join('').split('"/raw/*"').join(''), 'no other raw-bucket prefix')
        .not.toMatch(/\/[a-z*?_]+\/?\*?"/);
    }
    const readsOrDeletes = ['s3:GetObject*', 's3:DeleteObject*', 's3:DeleteObject'].flatMap((action) => rawGrants(action));
    expect(readsOrDeletes).toStrictEqual([]);
  });
});

// The s3_import ingestor is also invoked directly by the API (POST /s3-import/reprocess),
// so it reads only records naming the bucket it is configured for (handler.py IMPORT_BUCKET).
describe('VocIngestionStack s3_import ingestor bucket check', () => {
  let template: Template;
  beforeAll(() => {
    template = synthIngestionTemplate(['webscraper', 's3_import']);
  });

  const ingestorFunction = (pluginId: string) => {
    const ids = Object.keys(template.findResources('AWS::Lambda::Function'))
      .filter((id) => id.startsWith(`Ingestor${capitalize(pluginId)}`));
    expect(ids).toHaveLength(1);
    return IngestorFunctionSchema.parse(template.findResources('AWS::Lambda::Function')[itemAt(ids, 0)]).Properties;
  };
  const ingestorEnv = (pluginId: string) => ingestorFunction(pluginId).Environment.Variables;

  it('names the import bucket on the s3_import ingestor', () => {
    const [bucketId] = Object.keys(template.findResources('AWS::S3::Bucket'))
      .filter((id) => id.startsWith('S3ImportBucket'));
    expect(bucketId).toBeDefined();
    expect(ingestorEnv('s3_import')[S3_IMPORT_BUCKET_ENV]).toStrictEqual({ Ref: bucketId });
  });

  // The raw archive records the plugin's manifest version as each object's connector-version
  // (plugins/_shared/raw_archive.py `plugin_connector`).
  it.each(['webscraper', 's3_import'])('%s carries its manifest version as PLUGIN_VERSION', (pluginId) => {
    const manifest = z.object({ version: z.string() }).parse(JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'plugins', pluginId, 'manifest.json'), 'utf8')));
    expect(ingestorEnv(pluginId)['PLUGIN_VERSION']).toBe(manifest.version);
  });

  it('PLUGIN_VERSION is the variable the raw archive reads', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'plugins', '_shared', 'raw_archive.py'), 'utf8');
    expect(source).toContain('os.environ.get("PLUGIN_VERSION")');
  });

  it('sets no import bucket on an ingestor without an S3 trigger', () => {
    expect(ingestorEnv('webscraper')).not.toHaveProperty(S3_IMPORT_BUCKET_ENV);
  });

  it('is the variable the ingestor reads', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'plugins', 's3_import', 'ingestor', 'handler.py'), 'utf8');
    expect(source).toContain(`os.environ.get("${S3_IMPORT_BUCKET_ENV}", "")`);
  });

  // The ingestor closes a reprocess run's SOURCE_RUN#s3_import row (BaseIngestor._update_source_run_status):
  // without the table name and UpdateItem on it, every run would stay `running`.
  it('names the aggregates table and may update it', () => {
    expect(ingestorEnv('s3_import')).toHaveProperty('AGGREGATES_TABLE');
    const [roleId] = ingestorFunction('s3_import').Role['Fn::GetAtt'];
    const updates = Object.values(template.findResources('AWS::IAM::Policy'))
      .map((resource) => IamPolicySchema.parse(resource).Properties)
      .filter((policy) => policy.Roles.some((role) => role.Ref === roleId))
      .flatMap((policy) => policy.PolicyDocument.Statement)
      .filter((statement) => [statement.Action].flat().includes('dynamodb:UpdateItem'));
    expect(updates.some((statement) => JSON.stringify(statement.Resource).includes('Aggregates'))).toBe(true);
  });
});

const CorsBucketSchema = z.object({
  Properties: z.object({
    CorsConfiguration: z.object({ CorsRules: z.array(z.object({ AllowedOrigins: z.array(z.string()) }).loose()) }),
  }),
});

// The browser uploads staged files straight to the bucket, so its CORS origin is the app's own CloudFront
// domain (the frontendDomain prop, bin/voc-datalake.ts). A `-c frontendDomain=` context value once overrode
// an empty prop; nothing passes one, and it is not a deploy option.
describe('VocIngestionStack S3 import bucket CORS', () => {
  const origins = (context: Record<string, unknown> = {}) => {
    const buckets = Object.entries(synthIngestionTemplate([], context).findResources('AWS::S3::Bucket'))
      .filter(([logicalId]) => logicalId.startsWith('S3ImportBucket'));
    return CorsBucketSchema.parse(itemAt(buckets, 0)[1]).Properties.CorsConfiguration.CorsRules
      .flatMap((rule) => rule.AllowedOrigins);
  };

  it('allows the frontend domain and the local dev servers', () => {
    expect(origins()).toStrictEqual(['https://app.example.invalid', 'http://localhost:5173', 'http://localhost:3000']);
  });

  it('ignores a frontendDomain context value', () => {
    expect(origins({ frontendDomain: 'other.example.invalid' })).not.toContain('https://other.example.invalid');
  });

  it('refuses an empty or padded frontend domain instead of allowing https://', () => {
    expect(() => synthIngestionStacks([], {}, '')).toThrow(/frontend \(CloudFront\) domain/);
    expect(() => synthIngestionStacks([], {}, '  ')).toThrow(/frontend \(CloudFront\) domain/);
    expect(() => synthIngestionStacks([], {}, ' app.example.invalid ')).toThrow(/frontend \(CloudFront\) domain/);
  });
});
