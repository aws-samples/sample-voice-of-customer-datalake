/**
 * Who may delete customer data, workspace artifacts or audit rows, across the WHOLE app (every stack, real entrypoint).
 *
 * TENETS.md D5 and the wave C owner decisions:
 *   - customer data (raw items, feedback derived from them) is deleted only for a legal obligation, by voc-retention;
 *   - workspace artifacts (projects, personas, documents, boards, lists, conversations, their S3 objects) are really
 *     deleted when their owner deletes them, by the API that serves the owner;
 *   - no role holds a delete it does not use (lib/utils/table-write-grants.ts): a role that deletes operational
 *     rows in a shared table gets the delete pinned by `dynamodb:LeadingKeys` to those rows' partitions.
 *
 * Per-role suites pin least privilege role by role; this one pins the complete inventory, so a NEW delete grant
 * anywhere (a `grantReadWriteData`, a `grantReadWrite`, an explicit DeleteItem / BatchWriteItem / s3:DeleteObject*)
 * fails here even when nobody wrote a per-role case for it. Each entry says why the role deletes.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cleanupAssemblyDirs, synthApp } from './test-support/synth-app';
import { byCodeUnit } from './utils/compare';

const RETENTION_ROLE = 'VocProcessingStack/RetentionWorkerRetentionRole';
const PROJECTS_API = 'VocApiStack/ProjectsLambdaRole';
const PERSONA_GENERATOR = 'VocApiStack/PersonaGeneratorRole';
const ENGAGEMENT_API = 'VocApiStack/EngagementLambdaRole';
const SETTINGS_API = 'VocApiStack/SettingsLambdaRole';

/** `ALL`: the whole table; otherwise the `dynamodb:LeadingKeys` patterns the delete is pinned to. */
const ALL = 'whole table';
type Scope = typeof ALL | readonly string[];
interface Deleter { readonly scope: Scope; readonly why: string }

/** The circuit breaker's own row (plugins/_shared/circuit_breaker.py, shared/plugin_circuit.py). */
const CIRCUIT_ROW: Deleter = { scope: ['CIRCUIT#*'], why: 'clears its tripped circuit-breaker row' };
/** Every ingestor role the default synth creates (lib/stacks/ingestion-roles.ts). */
const INGESTOR_ROLES = [
  'IngestionLambdaRole', 'IngestorRoleAppReviewsAndroid', 'IngestorRoleAppReviewsIos', 'IngestorRoleGithubIssues',
  'IngestorRoleSyntheticReviews', 'IngestorRoleWebReviews', 'IngestorRoleWebscraper',
].map((id) => `VocIngestionStack/${id}`);

/** Every DynamoDB table that holds customer data, workspace artifacts or audit rows → who may delete there. */
const TABLE_DELETERS: Readonly<Record<string, Readonly<Record<string, Deleter>>>> = {
  FeedbackTable: {
    [RETENTION_ROLE]: { scope: ALL, why: 'erasure requests and declared retention limits (docs/source-policies.md)' },
  },
  AggregatesTable: {
    'VocApiStack/IntegrationsLambdaRole': CIRCUIT_ROW,
    ...Object.fromEntries(INGESTOR_ROLES.map((role) => [role, CIRCUIT_ROW])),
    'VocApiStack/LogsLambdaRole': { scope: ['LOGS#validation#*'], why: 'DELETE /logs/validation/{source}' },
    'VocApiStack/FeedbackFormLambdaRole': { scope: ['FEEDBACK_FORM'], why: 'DELETE /feedback-forms/{id} (the config row)' },
    [PROJECTS_API]: {
      scope: ['PRIORITIZATION', 'VOTING_SESSION_ROW'],
      why: 'a deleted Prioritization row with its ballots, and a closed vote\'s pointer',
    },
    [SETTINGS_API]: { scope: ['BRIEFSUB'], why: 'the morning-brief subscriber row when a user turns the brief off' },
  },
  ProjectsTable: {
    [PROJECTS_API]: { scope: ALL, why: 'workspace deletes: projects, personas, documents, revisions, comments, links' },
    [PERSONA_GENERATOR]: { scope: ALL, why: 'replace mode deletes the personas it replaces' },
  },
  JobsTable: {
    [PROJECTS_API]: { scope: ALL, why: 'a project delete sweeps its job rows' },
    'VocApiStack/GlobalMcpTokensApiRole': { scope: ['MCPOAUTH#*'], why: 'consumes single-use OAuth relay rows' },
  },
  ParticipantsTable: {
    [ENGAGEMENT_API]: { scope: ALL, why: 'list / person / project-link deletes and participant erasure' },
  },
  FeatureRequestsTable: {
    [ENGAGEMENT_API]: { scope: ALL, why: 'board, request and +1 deletes' },
  },
  ConversationsTable: {
    'VocApiStack/ChatLambdaRole': { scope: ALL, why: 'DELETE /chat/conversations/{id} (the caller\'s own)' },
  },
  // Nothing is deleted in these: memory forgets by tombstone, agents archive, Radar never removes a review.
  MemoryTable: {},
  AgentsTable: {},
  RadarTable: {},
};

/** A sample object key per customer / workspace prefix of the raw bucket, matched against each grant's ARN glob. */
const RAW_BUCKET_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  'raw/': ['raw/webscraper/2026/01/01/abc/0123456789abcdef.json', 'raw/csv_upload/2026/01/01/u.json'],
  'avatars/': ['avatars/persona_1_abc.png'],
  'prototypes/': ['prototypes/proj_1/doc_1.html'],
  'projects/*/product_docs/': ['projects/proj_1/product_docs/raw/doc.pdf', 'projects/proj_1/product_docs/extracted/doc.txt'],
  'company-context/': [
    'company-context/design/icons_abc.svg', 'company-context/design/logo_preview_abc.png', 'company-context/brief.md',
  ],
  'memory-imports/': ['memory-imports/imp_1.json'],
};

/** Prefix → who may delete objects there (any S3 delete action, versions included). */
const RAW_BUCKET_DELETERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'raw/': { [RETENTION_ROLE]: 'erasure requests and declared retention limits (never the whole-upload archives)' },
  'avatars/': {
    [PROJECTS_API]: 'project / persona deletes and superseded avatars',
    [PERSONA_GENERATOR]: 'the avatars of the personas a replace removes',
  },
  'prototypes/': { [PROJECTS_API]: 'document and project deletes' },
  'projects/*/product_docs/': { [PROJECTS_API]: 'product-doc and project deletes' },
  'company-context/': { [SETTINGS_API]: 'the design-capture previews (icons_*, logo_preview_*) it replaces' },
  'memory-imports/': {},
};

const StatementSchema = z.object({
  Effect: z.string().optional(),
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
  Condition: z.unknown().optional(),
});
const PolicySchema = z.object({
  Type: z.enum(['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy']),
  Properties: z.object({
    PolicyDocument: z.object({ Statement: z.array(StatementSchema) }),
    Roles: z.array(z.unknown()).optional(),
  }),
});
const TemplateSchema = z.object({ Resources: z.record(z.string(), z.unknown()) });
const LeadingKeysSchema = z.object({
  'ForAllValues:StringLike': z.object({ 'dynamodb:LeadingKeys': z.array(z.string()) }).optional(),
  'ForAllValues:StringEquals': z.object({ 'dynamodb:LeadingKeys': z.array(z.string()) }).optional(),
});

interface Grant { role: string; managed: boolean; actions: string[]; resource: string; condition: unknown }

const DYNAMO_DELETE = /^dynamodb:(DeleteItem|BatchWriteItem|PartiQLDelete|\*)$/;
const S3_DELETE = /^s3:(Delete.*|\*)$/;

/** `<Stack>/<RoleId>` for a CDK default policy logical id (`<RoleId>DefaultPolicy<hash>`). */
function roleOf(stack: string, policyId: string): string {
  return `${stack}/${policyId.replace(/DefaultPolicy[0-9A-F]{8}$/, '')}`;
}

const synthed = synthApp();
afterAll(cleanupAssemblyDirs);

function allowGrants(): Grant[] {
  return synthed.stackNames.flatMap((stack) => {
    const { Resources } = TemplateSchema.parse(synthed.template(stack));
    return Object.entries(Resources).flatMap(([id, resource]) => {
      const policy = PolicySchema.safeParse(resource);
      if (!policy.success) return [];
      // A managed policy is judged under its own id: no table or bucket delete may live in one.
      return policy.data.Properties.PolicyDocument.Statement
        .filter((statement) => (statement.Effect ?? 'Allow') === 'Allow')
        .map((statement) => ({
          role: roleOf(stack, id),
          managed: policy.data.Type === 'AWS::IAM::ManagedPolicy',
          actions: [statement.Action].flat(),
          resource: JSON.stringify(statement.Resource),
          condition: statement.Condition,
        }));
    });
  });
}

// Parsed once: every case filters the same statements.
const grants = allowGrants();

/** The LeadingKeys patterns a statement is pinned to, or ALL. */
function scopeOf(grant: Grant): Scope {
  if (grant.condition === undefined) return ALL;
  const parsed = LeadingKeysSchema.parse(grant.condition);
  const keys = parsed['ForAllValues:StringLike'] ?? parsed['ForAllValues:StringEquals'];
  if (keys === undefined) throw new Error(`${grant.role}: a delete with a condition that is not LeadingKeys`);
  return [...keys['dynamodb:LeadingKeys']].sort(byCodeUnit);
}

/** Matches the table itself (`<table>` / `<table>/index/...`) by its logical id in a GetAtt or an import. */
const onTable = (table: string) => (grant: Grant) => new RegExp(`${table}[0-9A-F]{8}`).test(grant.resource);

function tableDeleters(table: string): Record<string, Scope> {
  const out: Record<string, Scope> = {};
  for (const grant of grants.filter(onTable(table)).filter((g) => g.actions.some((a) => DYNAMO_DELETE.test(a)))) {
    const scope = scopeOf(grant);
    const held = out[grant.role];
    out[grant.role] = held === ALL || scope === ALL ? ALL : [...new Set([...(held ?? []), ...scope])].sort(byCodeUnit);
  }
  return out;
}

/** The object-key globs a raw-bucket statement names (`/*` = the whole bucket). */
function rawBucketGlobs(grant: Grant): string[] {
  if (!grant.resource.includes('RawDataBucket')) return [];
  return [...grant.resource.matchAll(/"\/([^"]*)"/g)].map((match) => match[1]);
}

const globMatches = (glob: string, key: string): boolean =>
  new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(key);

function prefixDeleters(prefix: string): string[] {
  const samples = RAW_BUCKET_PREFIXES[prefix];
  return [...new Set(grants
    .filter((grant) => grant.actions.some((action) => S3_DELETE.test(action)))
    .filter((grant) => rawBucketGlobs(grant).some((glob) => samples.some((key) => globMatches(glob, key))))
    .map((grant) => grant.role))].sort(byCodeUnit);
}

describe('customer-data, workspace and audit deletes across every stack', () => {
  it('names every table and prefix it guards', () => {
    expect(Object.keys(TABLE_DELETERS).sort(byCodeUnit)).toStrictEqual([
      'AgentsTable', 'AggregatesTable', 'ConversationsTable', 'FeatureRequestsTable', 'FeedbackTable', 'JobsTable',
      'MemoryTable', 'ParticipantsTable', 'ProjectsTable', 'RadarTable',
    ]);
    expect(Object.keys(RAW_BUCKET_DELETERS)).toStrictEqual(Object.keys(RAW_BUCKET_PREFIXES));
  });

  it.each(Object.entries(TABLE_DELETERS))('%s: exactly the allowlisted roles delete, each in its scope', (table, allowed) => {
    const expected = Object.fromEntries(Object.entries(allowed).map(([role, deleter]) =>
      [role, deleter.scope === ALL ? ALL : [...deleter.scope].sort(byCodeUnit)]));
    expect(tableDeleters(table)).toStrictEqual(expected);
  });

  it.each(Object.entries(RAW_BUCKET_DELETERS))('raw bucket %s: exactly the allowlisted roles delete', (prefix, allowed) => {
    expect(prefixDeleters(prefix)).toStrictEqual(Object.keys(allowed).sort(byCodeUnit));
  });

  it('voc-retention deletes only under raw/, never bucket-wide', () => {
    const rawDeletes = grants.filter((g) => g.role === RETENTION_ROLE && g.actions.some((a) => S3_DELETE.test(a)));
    expect(rawDeletes.flatMap(rawBucketGlobs)).toStrictEqual(['raw/*']);
  });

  it('no role deletes bucket-wide in the raw bucket', () => {
    const bucketWide = grants.filter((g) => g.actions.some((a) => S3_DELETE.test(a)) && rawBucketGlobs(g).includes('*'));
    expect(bucketWide.map((g) => g.role)).toStrictEqual([]);
  });

  it('no managed policy carries a table or raw-bucket delete', () => {
    const inManaged = grants.filter((g) => g.managed)
      .filter((g) => g.actions.some((a) => DYNAMO_DELETE.test(a) || S3_DELETE.test(a)))
      .filter((g) => g.resource.includes('Table') || g.resource.includes('RawDataBucket'));
    expect(inManaged.map((g) => g.role)).toStrictEqual([]);
  });
});
