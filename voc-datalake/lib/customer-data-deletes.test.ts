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

import { IamAnyPolicySchema, TemplateResourcesSchema } from './test-support/iam-statements';
import { cleanupAssemblyDirs, synthApp } from './test-support/synth-app';
import { byCodeUnit } from './utils/compare';

const RETENTION_ROLE = 'VocProcessingStack/RetentionWorkerRetentionRole';
const PROJECTS_API = 'VocApiStack/ProjectsLambdaRole';
const PERSONA_GENERATOR = 'VocApiStack/PersonaGeneratorRole';
const ENGAGEMENT_API = 'VocApiStack/EngagementLambdaRole';
const SETTINGS_API = 'VocApiStack/SettingsLambdaRole';

/** `WHOLE_TABLE`: no key condition; otherwise the `dynamodb:LeadingKeys` patterns the delete is pinned to. */
const ALL = '<whole table>';
type Scope = readonly string[];
const WHOLE_TABLE: Scope = [ALL];
interface Deleter { readonly scope: Scope; readonly why: string }

/** The breaker's row as the plugin ingestors write and clear it, and as the integrations API resets it
 * (shared/plugin_circuit.py): deployment-wide, and one per workspace for a run in one or a request in one
 * (plugins/_shared/circuit_breaker.py). */
const WORKSPACE_CIRCUIT_ROW: Deleter = {
  scope: ['CIRCUIT#*', 'WS#ws_??????????????????????????#CIRCUIT#*'], why: 'clears its tripped circuit-breaker row (deployment-wide or the run\'s workspace)',
};
/** Every ingestor role the default synth creates (lib/stacks/ingestion-roles.ts). */
const INGESTOR_ROLES = [
  'IngestorRoleS3Import', 'IngestorRoleAppReviewsAndroid', 'IngestorRoleAppReviewsIos', 'IngestorRoleGithubIssues',
  'IngestorRoleSyntheticReviews', 'IngestorRoleWebReviews', 'IngestorRoleWebscraper',
].map((id) => `VocIngestionStack/${id}`);

/** Every DynamoDB table that holds customer data, workspace artifacts or audit rows → who may delete there. */
const TABLE_DELETERS: Readonly<Record<string, Readonly<Record<string, Deleter>>>> = {
  FeedbackTable: {
    [RETENTION_ROLE]: { scope: WHOLE_TABLE, why: 'erasure requests and declared retention limits (docs/source-policies.md)' },
  },
  AggregatesTable: {
    'VocApiStack/IntegrationsLambdaRole': WORKSPACE_CIRCUIT_ROW,
    ...Object.fromEntries(INGESTOR_ROLES.map((role) => [role, WORKSPACE_CIRCUIT_ROW])),
    'VocApiStack/LogsLambdaRole': { scope: ['LOGS#validation#*'], why: 'DELETE /logs/validation/{source}' },
    'VocApiStack/FeedbackFormLambdaRole': {
      scope: ['FEEDBACK_FORM', 'WS#ws_??????????????????????????#FEEDBACK_FORM'],
      why: 'DELETE /feedback-forms/{id} (the config row, the deployment\'s or one workspace\'s)',
    },
    [PROJECTS_API]: {
      scope: ['PRIORITIZATION', 'VOTING_SESSION_ROW'],
      why: 'a deleted Prioritization row with its ballots, and a closed vote\'s pointer',
    },
    [SETTINGS_API]: { scope: ['BRIEFSUB'], why: 'the morning-brief subscriber row when a user turns the brief off' },
  },
  ProjectsTable: {
    [PROJECTS_API]: { scope: WHOLE_TABLE, why: 'workspace deletes: projects, personas, documents, revisions, comments, links' },
    [PERSONA_GENERATOR]: { scope: WHOLE_TABLE, why: 'replace mode deletes the personas it replaces' },
  },
  JobsTable: {
    [PROJECTS_API]: { scope: WHOLE_TABLE, why: 'a project delete sweeps its job rows' },
    'VocApiStack/GlobalMcpTokensApiRole': { scope: ['MCPOAUTH#*'], why: 'consumes single-use OAuth relay rows' },
  },
  ParticipantsTable: {
    [ENGAGEMENT_API]: { scope: WHOLE_TABLE, why: 'list / person / project-link deletes and participant erasure' },
  },
  FeatureRequestsTable: {
    [ENGAGEMENT_API]: { scope: WHOLE_TABLE, why: 'board, request and +1 deletes' },
    [RETENTION_ROLE]: { scope: ['FR#*'], why: 'an erasure by email re-keys the erased +1 (its id derives from the email)' },
  },
  ConversationsTable: {
    'VocApiStack/ChatLambdaRole': { scope: WHOLE_TABLE, why: 'DELETE /chat/conversations/{id} (the caller\'s own)' },
  },
  // Nothing is deleted in these: memory forgets by tombstone, agents archive.
  MemoryTable: {},
  AgentsTable: {},
  RadarTable: {
    [RETENTION_ROLE]: { scope: WHOLE_TABLE, why: 'erasure and retention reach Radar reviews and their dedupe markers (docs/radar.md)' },
  },
  // The multi-workspace control plane (docs/multi-workspace.md). Membership rows are access configuration, not
  // customer data (D5 covers feedback and raw items); a removal is audited first (AUDIT#WS#, under the audit-row
  // guard). IAM pins the partition, not the sort key: `WS#*` also reaches META, which only the code keeps out
  // (lambda/shared/workspace_members.py; its tests pin the keys it deletes); SLUG#, WORKSPACES and AUDIT# stay out.
  // Workspace delete is still an open tenet question for phase 4. The users API deletes a deleted user's memberships
  // (6.11.00, lambda/shared/workspace_members.py remove_user_memberships), each audited first, in the same scope.
  WorkspacesTable: {
    'VocApiStack/WorkspacesLambdaRole': {
      scope: ['PLUGIN#*', 'USER#*', 'WS#*'],
      why: 'membership removal (MEMBER# and USER# rows only) and a disabled plugin\'s PLUGIN# row: configuration',
    },
    'VocApiStack/UsersLambdaRole': {
      scope: ['USER#*', 'WS#*'], why: 'a deleted user\'s memberships: their MEMBER# and USER# rows only, before the account goes',
    },
    // A workspace form's lookup row (routing configuration, not customer data; lambda/shared/workspace_routing.py
    // release_lookup, conditional on the row naming the workspace): removed with the form it routes to.
    'VocApiStack/FeedbackFormLambdaRole': { scope: ['FORM#*'], why: 'a deleted workspace form\'s FORM#{id} lookup row' },
  },
};

const DYNAMO_WRITE = /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|PartiQL(Insert|Update|Delete)|\*)$/;

/**
 * Who may write voc-workspaces, and where: the workspaces API alone, in the partitions a workspace's creation writes
 * (lambda/shared/platform_workspaces.py: `SLUG#`, `WS#`, `USER#`, the `WORKSPACES` listing, `AUDIT#WS#`), its entry
 * audit rows and a membership's add, role change and removal (lambda/shared/workspace_members.py: `WS#` / `MEMBER#`,
 * `USER#`, `AUDIT#WS#`); its only delete is the removal's (TABLE_DELETERS above). Since 6.11.00 two more: the users
 * API, for a deleted user's memberships (puts their `AUDIT#WS#` rows, deletes their `MEMBER#` and `USER#` rows), and
 * voc-retention, for an erasure by email (updates `email` and `name` only, under `WS#`: lambda/jobs/retention/members.py).
 */
const WORKSPACE_WRITERS: Readonly<Record<string, Scope>> = {
  'VocApiStack/WorkspacesLambdaRole': ['AUDIT#WS#*', 'PLUGIN#*', 'SLUG#*', 'USER#*', 'WORKSPACES', 'WS#*'],
  'VocApiStack/UsersLambdaRole': ['AUDIT#WS#*', 'USER#*', 'WS#*'],
  // A platform admin's entry into a workspace from a domain API: the stack's one workspace-resolution policy, attached
  // to each domain API's role that resolves (lib/utils/workspace-resolution-grants.ts): the settings API, and since
  // 7.04.00 the metrics API, the feedback edits and the integrations and scrapers APIs.
  'VocApiStack/WorkspaceResolutionPolicy': ['AUDIT#WS#*'],
  [RETENTION_ROLE]: ['WS#*'],
  // The feedback forms (7.06.00): a workspace form's lookup row (put on create, deleted with the form); its entry and
  // form_deleted audit rows go through the workspace-resolution policy above.
  'VocApiStack/FeedbackFormLambdaRole': ['FORM#*'],
};

/** A sample object key per customer / workspace prefix of the raw bucket, matched against each grant's ARN glob. */
const RAW_BUCKET_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  'raw/': [
    'raw/webscraper/2026/01/01/abc/0123456789abcdef.json', 'raw/csv_upload/2026/01/01/u.json',
    // The boards' opt-in raw copies (lambda/shared/feature_requests_raw.py): an erasure by email reaches them.
    'raw/feature_requests/2026/01/01/fr_0123456789ab/0123456789abcdef.json',
  ],
  // The kept Silver versions of an edited item (lambda/shared/silver_provenance.py): copies of customer data.
  'silver/': ['silver/webscraper/abc/20260101T000000000000Z-0a0b0c0d.json'],
  // A tenant workspace's bronze and Silver history (docs/multi-workspace.md): its copies of customer data.
  'ws/*/raw/': ['ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/raw/webscraper/2026/01/01/abc/0123456789abcdef.json'],
  'ws/*/silver/': ['ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/silver/webscraper/abc/20260101T000000000000Z-0a0b0c0d.json'],
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
  'silver/': { [RETENTION_ROLE]: 'every kept version of an erased or expired item, and a whole-source sweep' },
  // D5: an erasure by email and a retention window are legal obligations that reach every copy, a workspace's
  // included (the deployment's erasure, the deployment's source profiles a workspace's items are processed under; a
  // whole-source erasure never deletes there, in code: lambda/shared/retention.py `reaches_workspaces`).
  'ws/*/raw/': { [RETENTION_ROLE]: 'an erasure by email or a retention window reaches every raw version of a workspace\'s matching item' },
  'ws/*/silver/': { [RETENTION_ROLE]: 'an erasure by email or a retention window reaches every kept version of a workspace\'s matching item' },
  'avatars/': {
    [PROJECTS_API]: 'project / persona deletes and superseded avatars',
    [PERSONA_GENERATOR]: 'the avatars of the personas a replace removes',
  },
  'prototypes/': { [PROJECTS_API]: 'document and project deletes' },
  'projects/*/product_docs/': { [PROJECTS_API]: 'product-doc and project deletes' },
  'company-context/': { [SETTINGS_API]: 'the design-capture previews (icons_*, logo_preview_*) it replaces' },
  'memory-imports/': {},
};

const LeadingKeysSchema = z.object({
  'ForAllValues:StringLike': z.object({ 'dynamodb:LeadingKeys': z.array(z.string()) }).optional(),
  // StringEquals may also name the attributes an update may touch (dynamodb:Attributes): not a key scope.
  'ForAllValues:StringEquals': z.object({
    'dynamodb:LeadingKeys': z.array(z.string()).optional(), 'dynamodb:Attributes': z.array(z.string()).optional(),
  }).optional(),
});

interface Grant { role: string; managed: boolean; actions: string[]; resource: string; condition: unknown }

const DYNAMO_DELETE = /^dynamodb:(DeleteItem|BatchWriteItem|PartiQLDelete|\*)$/;
const S3_DELETE = /^s3:(Delete.*|\*)$/;

/** `<Stack>/<RoleId>` for a CDK default policy logical id (`<RoleId>DefaultPolicy<hash>`), `<Stack>/<PolicyId>` for a
 *  customer-managed policy's (`<PolicyId><hash>`). */
function roleOf(stack: string, policyId: string): string {
  return `${stack}/${policyId.replace(/(?:DefaultPolicy)?[0-9A-F]{8}$/, '')}`;
}

const synthed = synthApp();
afterAll(cleanupAssemblyDirs);

function allowGrants(): Grant[] {
  return synthed.stackNames.flatMap((stack) => {
    const { Resources } = TemplateResourcesSchema.parse(synthed.template(stack));
    return Object.entries(Resources).flatMap(([id, resource]) => {
      const policy = IamAnyPolicySchema.safeParse(resource);
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

/** The LeadingKeys patterns a statement is pinned to; `WHOLE_TABLE` when it has no condition. */
function scopeOf(grant: Grant): Scope {
  if (grant.condition === undefined) return WHOLE_TABLE;
  const parsed = LeadingKeysSchema.parse(grant.condition);
  const keys = parsed['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']
    ?? parsed['ForAllValues:StringEquals']?.['dynamodb:LeadingKeys'];
  if (keys === undefined) throw new Error(`${grant.role}: a delete with a condition that is not LeadingKeys`);
  return [...keys].sort(byCodeUnit);
}

/** Matches the table itself (`<table>` / `<table>/index/...`) by its logical id in a GetAtt or an import. */
const onTable = (table: string) => (grant: Grant) => new RegExp(`${table}[0-9A-F]{8}`).test(grant.resource);

/** Two scopes of one role together: the whole table wins over any key list. */
const unionOf = (a: Scope, b: Scope): Scope => (a.includes(ALL) || b.includes(ALL)
  ? WHOLE_TABLE : [...new Set([...a, ...b])].sort(byCodeUnit));

function tableDeleters(table: string): Record<string, Scope> {
  const out: Record<string, Scope> = {};
  for (const grant of grants.filter(onTable(table)).filter((g) => g.actions.some((a) => DYNAMO_DELETE.test(a)))) {
    out[grant.role] = unionOf(out[grant.role] ?? [], scopeOf(grant));
  }
  return out;
}

/** The object-key globs a raw-bucket statement names (`/*` = the whole bucket). */
function rawBucketGlobs(grant: Grant): string[] {
  if (!grant.resource.includes('RawDataBucket')) return [];
  return [...grant.resource.matchAll(/"\/([^"]*)"/g)].flatMap((match) => match[1] ?? []);
}

/** IAM's ARN globbing: `*` any run of characters (`/` included), `?` exactly one (the workspace id patterns). */
const globMatches = (glob: string, key: string): boolean =>
  new RegExp(`^${[...glob].map((char) => {
    if (char === '*') return '.*';
    if (char === '?') return '.';
    return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('')}$`).test(key);

function prefixDeleters(prefix: string): string[] {
  const samples = RAW_BUCKET_PREFIXES[prefix] ?? [];
  return [...new Set(grants
    .filter((grant) => grant.actions.some((action) => S3_DELETE.test(action)))
    .filter((grant) => rawBucketGlobs(grant).some((glob) => samples.some((key) => globMatches(glob, key))))
    .map((grant) => grant.role))].sort(byCodeUnit);
}

describe('customer-data, workspace and audit deletes across every stack', () => {
  it('names every table and prefix it guards', () => {
    expect(Object.keys(TABLE_DELETERS).sort(byCodeUnit)).toStrictEqual([
      'AgentsTable', 'AggregatesTable', 'ConversationsTable', 'FeatureRequestsTable', 'FeedbackTable', 'JobsTable',
      'MemoryTable', 'ParticipantsTable', 'ProjectsTable', 'RadarTable', 'WorkspacesTable',
    ]);
    expect(Object.keys(RAW_BUCKET_DELETERS)).toStrictEqual(Object.keys(RAW_BUCKET_PREFIXES));
  });

  it.each(Object.entries(TABLE_DELETERS))('%s: exactly the allowlisted roles delete, each in its scope', (table, allowed) => {
    const expected = Object.fromEntries(Object.entries(allowed).map(([role, deleter]) =>
      [role, [...deleter.scope].sort(byCodeUnit)]));
    expect(tableDeleters(table)).toStrictEqual(expected);
  });

  // The order docs/multi-workspace.md (Control plane) asked for, held by a test rather than prose: no role could write
  // a workspace (META) or a membership (MEMBER#, USER#) before the users-API safeguards for platform-admins (6.08.00)
  // and the live platform-admin check on entering a workspace (6.09.00, lambda/shared/workspace.py). Both landed; the
  // change that creates workspaces (6.09.00) is the one that widened WORKSPACE_WRITERS; the members routes (6.10.00)
  // write within the same partitions (role updates and removals in `USER#*` and `WS#*`); 6.11.00 adds the users API (a
  // deleted user's memberships) and voc-retention (an erasure by email's de-identification); the workspace-resolution
  // policy of the domain APIs that act in a workspace (the settings API first), the entry audit row of a platform admin
  // (`AUDIT#WS#*`, a new row only). A new writer or partition is a decision recorded here.
  it('voc-workspaces: only the workspaces and users APIs, the domain APIs\' resolution and voc-retention write, each in its partitions', () => {
    const writers: Record<string, Scope> = {};
    for (const grant of grants.filter(onTable('WorkspacesTable')).filter((g) => g.actions.some((a) => DYNAMO_WRITE.test(a)))) {
      writers[grant.role] = unionOf(writers[grant.role] ?? [], scopeOf(grant));
    }
    expect(writers).toStrictEqual(WORKSPACE_WRITERS);
  });

  it.each(Object.entries(RAW_BUCKET_DELETERS))('raw bucket %s: exactly the allowlisted roles delete', (prefix, allowed) => {
    expect(prefixDeleters(prefix)).toStrictEqual(Object.keys(allowed).sort(byCodeUnit));
  });

  it('voc-retention deletes only under raw/ and silver/ and each workspace\'s raw/ and silver/, never bucket-wide', () => {
    const rawDeletes = grants.filter((g) => g.role === RETENTION_ROLE && g.actions.some((a) => S3_DELETE.test(a)));
    // One workspace id per pattern (`ws_` + 26 `?`): `ws/*/raw/*` would also reach `ws/{ws}/silver/raw/…`.
    const ws = `ws/ws_${'?'.repeat(26)}`;
    expect(rawDeletes.flatMap(rawBucketGlobs).sort(byCodeUnit)).toStrictEqual(
      ['raw/*', 'silver/*', `${ws}/raw/*`, `${ws}/silver/*`].sort(byCodeUnit));
  });

  it('voc-retention reaches the feedback boards to de-identify and re-key (reads, UpdateItem, Put/Delete under FR#*)', () => {
    const onBoards = grants.filter((g) => g.role === RETENTION_ROLE).filter(onTable('FeatureRequestsTable'));
    expect([...new Set(onBoards.flatMap((g) => g.actions))].sort(byCodeUnit)).toStrictEqual([
      'dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:Scan',
      'dynamodb:UpdateItem',
    ]);
  });

  it('voc-retention reaches voc-workspaces to de-identify only (Scan, UpdateItem of email and name under WS#*)', () => {
    const onWorkspaces = grants.filter((g) => g.role === RETENTION_ROLE).filter(onTable('WorkspacesTable'));
    expect([...new Set(onWorkspaces.flatMap((g) => g.actions))].sort(byCodeUnit))
      .toStrictEqual(['dynamodb:Scan', 'dynamodb:UpdateItem']);
    const update = onWorkspaces.find((g) => g.actions.includes('dynamodb:UpdateItem'));
    expect(update?.condition).toStrictEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*'] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['email', 'name', 'pk', 'sk'] },
    });
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
