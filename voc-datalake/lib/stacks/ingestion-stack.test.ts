/**
 * VocIngestionStack: the S3-import staging bucket's data-protection settings.
 *
 * Versioning is on (AWS S3 security best practice: recover from an accidental
 * overwrite or delete), and the lifecycle rules that keep it cheap on a staging
 * bucket are pinned here — dropping either half silently turns versioning into
 * unbounded storage growth, or turns the bucket back into one where a delete is
 * unrecoverable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import {
  IMPORT_ABORT_MULTIPART_DAYS,
  IMPORT_NONCURRENT_VERSION_DAYS,
  SCHEDULE_TARGET_MAX_EVENT_AGE,
  SCHEDULE_TARGET_RETRY_ATTEMPTS,
} from './ingestion-stack';
import { itemAt } from '../test-support/guards';
import { capitalize } from '../plugin-loader';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { byCodeUnit } from '../utils/compare';
import { SYNTH_ACCOUNT, SYNTH_REGION } from '../test-support/synth-app';


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
    expect(IMPORT_ABORT_MULTIPART_DAYS).toBe(1);
    expect(bucket.Properties.LifecycleConfiguration.Rules).toStrictEqual(expect.arrayContaining([
      {
        Id: 'staging-version-hygiene',
        Status: 'Enabled',
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
    QueueName: z.unknown(),
    KmsMasterKeyId: GetAttSchema,
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

  /** The schedule DLQ's Properties and the Properties of the CMK it is encrypted with. */
  const scheduleDlqAndKey = () => {
    const queue = QueueSchema.parse(template.findResources('AWS::SQS::Queue')[
      itemAt(logicalIdsStartingWith(template, 'AWS::SQS::Queue', 'IngestScheduleDLQ'), 0)
    ]).Properties;
    const [keyId] = queue.KmsMasterKeyId['Fn::GetAtt'];
    const KeySchema = z.object({
      Properties: z.object({
        EnableKeyRotation: z.boolean(),
        KeyPolicy: z.object({ Statement: z.array(z.looseObject({ Sid: z.string().optional() })) }),
      }),
    });
    return { queue, keyId, key: KeySchema.parse(template.findResources('AWS::KMS::Key')[keyId]).Properties };
  };

  it('encrypts the DLQ with its own rotated CMK', () => {
    const { keyId, key } = scheduleDlqAndKey();
    expect(keyId).toMatch(/^IngestScheduleDLQKey/);
    expect(key.EnableKeyRotation).toBe(true);
  });

  it('admits EventBridge to that CMK for this queue and account only', () => {
    const { queue, key } = scheduleDlqAndKey();
    const grant = z.object({
      Principal: z.object({ Service: z.literal('events.amazonaws.com') }),
      Action: z.array(z.string()),
      Condition: z.object({
        StringEquals: z.object({
          'kms:EncryptionContext:aws:sqs:arn': JoinSchema,
          'aws:SourceAccount': z.unknown(),
        }),
      }),
    }).parse(key.KeyPolicy.Statement.find((s) => s.Sid === 'AllowEventBridgeToDeadLetter'));
    expect([...grant.Action].sort(byCodeUnit)).toStrictEqual(['kms:Decrypt', 'kms:GenerateDataKey']);
    expect(grant.Condition.StringEquals['aws:SourceAccount']).toBe(SYNTH_ACCOUNT);
    // The context ARN must name THIS queue, and only it.
    expect(flattenJoin(grant.Condition.StringEquals['kms:EncryptionContext:aws:sqs:arn']))
      .toBe(`arn:aws:sqs:${SYNTH_REGION}:${SYNTH_ACCOUNT}:${flattenJoin(queue.QueueName)}`);
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

  it('creates no DLQ or key when no plugin is scheduled', () => {
    const bare = synthIngestionTemplate();
    expect(logicalIdsStartingWith(bare, 'AWS::SQS::Queue', 'IngestScheduleDLQ')).toHaveLength(0);
    expect(logicalIdsStartingWith(bare, 'AWS::KMS::Key', 'IngestScheduleDLQKey')).toHaveLength(0);
  });
});

// ── Circuit breaker: each ingestor may disable its OWN schedule, and only it ───
// plugins/_shared/circuit_breaker.py calls events:DisableRule with
// INGEST_SCHEDULE_RULE_NAME after repeated failures. It once never could (no
// client factory, no grant), so a tripped plugin kept being invoked every tick.
// A grant on the SHARED role, or a wildcard, would instead let any plugin switch
// off a sibling's ingestion.

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
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
});
const IamPolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(RefSchema),
    PolicyDocument: z.object({ Statement: z.array(PolicyStatementSchema) }),
  }),
});

/** Every `events:DisableRule` statement, with the role(s) its policy is attached to. */
function disableRuleGrants(template: Template): { roles: string[]; resource: unknown }[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap((resource) => {
    const policy = IamPolicySchema.parse(resource).Properties;
    return policy.PolicyDocument.Statement
      .filter((statement) => [statement.Action].flat().includes('events:DisableRule'))
      .map((statement) => ({ roles: policy.Roles.map((role) => role.Ref), resource: statement.Resource }));
  });
}

describe('VocIngestionStack circuit-breaker DisableRule grants', () => {
  // Two scheduled plugins and one unscheduled one.
  let template: Template;
  beforeAll(() => {
    template = synthIngestionTemplate(['webscraper', 'app_reviews_ios', 's3_import']);
  });

  const functionResource = (logicalId: string) =>
    IngestorFunctionSchema.parse(template.findResources('AWS::Lambda::Function')[logicalId]).Properties;

  /** Per schedule rule: its name, the ingestor it invokes, and that ingestor's env and role. */
  const scheduledIngestors = () => Object.values(template.findResources('AWS::Events::Rule'))
    .map((resource) => {
      const rule = ScheduledRuleSchema.parse(resource).Properties;
      const [functionId] = itemAt(rule.Targets, 0).Arn['Fn::GetAtt'];
      const fn = functionResource(functionId);
      return {
        ruleName: flattenJoin(rule.Name),
        envRuleName: flattenJoin(fn.Environment.Variables.INGEST_SCHEDULE_RULE_NAME),
        roleId: fn.Role['Fn::GetAtt'][0],
      };
    });

  it('names each ingestor its own schedule rule, for the breaker to disable', () => {
    const scheduled = scheduledIngestors();
    expect(scheduled).toHaveLength(2);
    expect(scheduled.map((s) => s.envRuleName)).toStrictEqual(scheduled.map((s) => s.ruleName));
  });

  it('grants each scheduled ingestor DisableRule on exactly its own rule ARN, on its own role', () => {
    const grants = disableRuleGrants(template);
    const scheduled = scheduledIngestors();
    expect(grants, 'one DisableRule statement per schedule rule').toHaveLength(scheduled.length);
    expect(new Set(scheduled.map((s) => s.roleId)).size, 'one role per scheduled ingestor')
      .toBe(scheduled.length);

    const granted = scheduled.map(({ roleId }) => grants
      .filter((grant) => grant.roles.includes(roleId))
      .map((grant) => ({ roles: grant.roles, resource: flattenJoin(grant.resource) })));
    expect(granted).toStrictEqual(scheduled.map(({ roleId, ruleName }) => [{
      roles: [roleId],
      resource: `arn:aws:events:${SYNTH_REGION}:${SYNTH_ACCOUNT}:rule/${ruleName}`,
    }]));
  });

  it('never grants DisableRule on a wildcard or to an unscheduled ingestor', () => {
    const grants = disableRuleGrants(template);
    expect(grants.map((grant) => flattenJoin(grant.resource)).filter((arn) => arn.includes('*')))
      .toStrictEqual([]);

    const unscheduled = Object.keys(template.findResources('AWS::Lambda::Function'))
      .filter((id) => id.startsWith(`Ingestor${capitalize('s3_import')}`));
    expect(unscheduled).toHaveLength(1);
    const fn = functionResource(itemAt(unscheduled, 0));
    expect(fn.Environment.Variables).not.toHaveProperty('INGEST_SCHEDULE_RULE_NAME');
    const [roleId] = fn.Role['Fn::GetAtt'];
    expect(grants.filter((grant) => grant.roles.includes(roleId))).toStrictEqual([]);
  });
});
