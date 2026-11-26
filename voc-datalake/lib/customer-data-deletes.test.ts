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
import { cleanupAssemblyDirs, HARD_DELETE_BUILD, synthApp } from './test-support/synth-app';
import { byCodeUnit } from './utils/compare';

const RETENTION_ROLE = 'VocProcessingStack/RetentionWorkerRetentionRole';
/** A workspace's hard delete (decision 17, docs/multi-workspace.md "Export and delete"; lib/stacks/workspace-delete-worker.ts):
 * the data controller's own request, with its stated basis, the slug typed as approval, audited, one tombstone per item
 * and memory first. Every key one workspace id's (`ws_` and 26 `?`), BatchWriteItem only on its own partitions. */
const DELETE_ROLE = 'VocProcessingStack/WorkspaceDeleteWorkerDeleteRole';
const ONE_WORKSPACE = `ws_${'?'.repeat(26)}`;
const WORKSPACE_DELETE: Deleter = {
  scope: [`WS#${ONE_WORKSPACE}#*`],
  why: 'a workspace\'s hard delete (decision 17): every partition of one workspace, after its tombstones',
};
/** A trial workspace's end (7.71.00): its pause, never a delete of data. */
const TRIAL_EXPIRY_ROLE = 'VocProcessingStack/TrialExpiryRole';
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
    [DELETE_ROLE]: { scope: [`WS#${ONE_WORKSPACE}#SOURCE#*`], why: WORKSPACE_DELETE.why },
  },
  AggregatesTable: {
    'VocApiStack/IntegrationsLambdaRole': {
      scope: [...WORKSPACE_CIRCUIT_ROW.scope, 'WEB_REVIEWS#METHODS', `WS#${ONE_WORKSPACE}#WEB_REVIEWS#METHODS`],
      why: `${WORKSPACE_CIRCUIT_ROW.why}; and "Re-check methods" clears one review site's learned-methods row (no `
        + 'review, no content; the deployment\'s or the request\'s workspace\'s, DELETE /integrations/web_reviews/methods/{domain})',
    },
    ...Object.fromEntries(INGESTOR_ROLES.map((role) => [role, WORKSPACE_CIRCUIT_ROW])),
    'VocApiStack/LogsLambdaRole': { scope: ['LOGS#validation#*'], why: 'DELETE /logs/validation/{source}' },
    'VocApiStack/FeedbackFormLambdaRole': {
      scope: ['FEEDBACK_FORM', 'WS#ws_??????????????????????????#FEEDBACK_FORM',
        'FEEDBACK_FORM_TEST', 'WS#ws_??????????????????????????#FEEDBACK_FORM_TEST'],
      why: 'DELETE /feedback-forms/{id} (the form\'s rows) and DELETE …/responses?test=true (its test responses), '
        + 'the deployment\'s or one workspace\'s',
    },
    [RETENTION_ROLE]: {
      // Their own partitions only: never a form's definition, revision or funnel row (the forms partitions).
      scope: ['FEEDBACK_FORM_TEST', 'WS#ws_??????????????????????????#FEEDBACK_FORM_TEST'],
      why: 'erasure requests and the feedback_form retention window reach the forms\' test responses (the '
        + 'deployment\'s or one workspace\'s)',
    },
    [PROJECTS_API]: {
      scope: ['PRIORITIZATION', 'VOTING_SESSION_ROW'],
      why: 'a deleted Prioritization row with its ballots, and a closed vote\'s pointer',
    },
    [SETTINGS_API]: { scope: ['BRIEFSUB'], why: 'the morning-brief subscriber row when a user turns the brief off' },
    [DELETE_ROLE]: WORKSPACE_DELETE,
  },
  ProjectsTable: {
    [PROJECTS_API]: { scope: WHOLE_TABLE, why: 'workspace deletes: projects, personas, documents, revisions, comments, links' },
    [PERSONA_GENERATOR]: { scope: WHOLE_TABLE, why: 'replace mode deletes the personas it replaces' },
    // A workspace's hard delete (7.28.00): its projects' partitions and document versions, its registry, and the
    // ids' claims. PROJECT_ID#* names no workspace in its key, so IAM reaches every claim: the code deletes only a
    // claim naming this workspace (release_project_claim's condition), of an id read from its own registry. Since
    // 7.37.00 also its series' comment partitions, its review links and their registry, and the links' routing rows:
    // DOCSHARE#* names no workspace either (a deployment's own link shares it), and the code deletes only a route
    // naming this workspace (release_share_route's condition), of an id read from its own registry.
    [DELETE_ROLE]: {
      scope: ['DOCSHARE#*', 'PROJECT_ID#*', `WS#${ONE_WORKSPACE}#DCOMMENTS#*`, `WS#${ONE_WORKSPACE}#DOCSHARE#*`,
        `WS#${ONE_WORKSPACE}#DOCSHARE_IDS`, `WS#${ONE_WORKSPACE}#DOCUMENT_VERSIONS#PROJECT#*`,
        `WS#${ONE_WORKSPACE}#LIBRARY`, `WS#${ONE_WORKSPACE}#LIBRARY_CHUNKS#*`,
        `WS#${ONE_WORKSPACE}#PROJECT#*`, `WS#${ONE_WORKSPACE}#PROJECT_IDS`],
      why: 'a workspace\'s hard delete (decision 17): its projects, comments and review links, their registries, their '
        + 'id claims and link routes, and (7.62.00) its Documents Library and the items\' passages',
    },
    // 7.48.00 (3g-d): the review registries' backfill marker reset (lib/stacks/review-registries-marker.ts), on its
    // create and its delete. DOCSHARE_IDS also holds the deployment's link registry; IAM cannot pin the sort key, so
    // the call names the marker's (no customer data: the marker is a row of the backfill's own).
    'VocCoreStack/ReviewRegistriesMarkerResetCustomResourcePolicy': {
      scope: ['DOCSHARE_IDS'],
      why: 'the backfill marker\'s reset when a release that keeps the review registries is installed or removed',
    },
  },
  JobsTable: {
    [PROJECTS_API]: { scope: WHOLE_TABLE, why: 'a project delete sweeps its job rows' },
    'VocApiStack/GlobalMcpTokensApiRole': { scope: ['MCPOAUTH#*'], why: 'consumes single-use OAuth relay rows' },
    [DELETE_ROLE]: { scope: [`WS#${ONE_WORKSPACE}#PROJECT#*`], why: 'a workspace\'s hard delete: its projects\' jobs' },
  },
  ParticipantsTable: {
    [ENGAGEMENT_API]: { scope: WHOLE_TABLE, why: 'list / person / project-link deletes and participant erasure' },
    // A workspace's hard delete: its projects' list links, and (7.31.00) its index of its people and lists and each
    // list, person and address guard it names (lambda/jobs/workspace_delete/sweeps.py `participants`).
    [DELETE_ROLE]: {
      scope: [`WS#${ONE_WORKSPACE}#EMAIL#*`, `WS#${ONE_WORKSPACE}#LIST#*`, `WS#${ONE_WORKSPACE}#PARTICIPANTS`,
        `WS#${ONE_WORKSPACE}#PERSON#*`, `WS#${ONE_WORKSPACE}#PROJECT#*`],
      why: 'a workspace\'s hard delete: its projects\' list links, and its people and lists',
    },
    // 7.72.00 (projects 3g2): an erasure by email erases each participant its address names, the deployment's and one
    // workspace id's (lambda/shared/participants_erasure.py `erase_person`): the guard, the person's rows and
    // memberships, its project links and tokens, and a workspace guard's index row. A legal obligation (D5).
    [RETENTION_ROLE]: {
      scope: ['EMAIL#*', 'LIST#*', 'PERSON#*', 'PROJECT#*', 'TOKEN#*', `WS#${ONE_WORKSPACE}#EMAIL#*`,
        `WS#${ONE_WORKSPACE}#LIST#*`, `WS#${ONE_WORKSPACE}#PARTICIPANTS`, `WS#${ONE_WORKSPACE}#PERSON#*`,
        `WS#${ONE_WORKSPACE}#PROJECT#*`],
      why: 'an erasure by email erases the participants its address names, in the deployment and in each workspace',
    },
  },
  FeatureRequestsTable: {
    [ENGAGEMENT_API]: { scope: WHOLE_TABLE, why: 'board, request and +1 deletes' },
    [RETENTION_ROLE]: { scope: ['FR#*'], why: 'an erasure by email re-keys the erased +1 (its id derives from the email)' },
  },
  ConversationsTable: {
    'VocApiStack/ChatLambdaRole': { scope: WHOLE_TABLE, why: 'DELETE /chat/conversations/{id} (the caller\'s own)' },
    // A workspace's hard delete: its list of conversation owners and each owner's WS#{one id}#USER#{sub}, never the
    // deployment's USER#{sub} (lambda/jobs/workspace_delete/sweeps.py `conversations`).
    [DELETE_ROLE]: {
      scope: [`WS#${ONE_WORKSPACE}#CONVERSANTS`, `WS#${ONE_WORKSPACE}#USER#*`],
      why: 'a workspace\'s hard delete (decision 17): its members\' conversations there and their owner list',
    },
  },
  // Memory forgets by tombstone and agents archive; only a workspace's hard delete removes a workspace's memory.
  MemoryTable: { [DELETE_ROLE]: WORKSPACE_DELETE },
  AgentsTable: {},
  RadarTable: {
    [RETENTION_ROLE]: { scope: WHOLE_TABLE, why: 'erasure and retention reach Radar reviews and their dedupe markers (docs/radar.md)' },
    // A workspace's hard delete: its Radar settings (WS#{one id}#SETTINGS#radar), one workspace's partitions only.
    [DELETE_ROLE]: WORKSPACE_DELETE,
  },
  // The multi-workspace control plane (docs/multi-workspace.md). Membership rows are access configuration, not
  // customer data (D5 covers feedback and raw items); a removal is audited first (AUDIT#WS#, under the audit-row
  // guard). IAM pins the partition, not the sort key: `WS#*` also reaches META, which only the code keeps out
  // (lambda/shared/workspace_members.py; its tests pin the keys it deletes); SLUG#, WORKSPACES and AUDIT# stay out.
  // Workspace delete was settled by decision 17 (phase 4d-2, its role below). The users API deletes a deleted user's memberships
  // (6.11.00, lambda/shared/workspace_members.py remove_user_memberships), each audited first, in the same scope.
  WorkspacesTable: {
    'VocApiStack/WorkspacesLambdaRole': {
      scope: ['PLUGIN#*', 'WORKSPACES', 'USER#*', 'WS#*'],
      why: 'membership removal (MEMBER# and USER# rows only), a disabled plugin\'s PLUGIN# row and a renamed workspace\'s '
        + 'old listing row (moved to its new sort key, 7.40.00): configuration',
    },
    'VocApiStack/UsersLambdaRole': {
      scope: ['USER#*', 'WS#*'], why: 'a deleted user\'s memberships: their MEMBER# and USER# rows only, before the account goes',
    },
    // A workspace form's lookup row (routing configuration, not customer data; lambda/shared/workspace_routing.py
    // release_lookup, conditional on the row naming the workspace): removed with the form it routes to.
    'VocApiStack/FeedbackFormLambdaRole': { scope: ['FORM#*'], why: 'a deleted workspace form\'s FORM#{id} lookup row' },
    // A workspace's hard delete: its own partition (META last, only while deleting; MEMBER# and the rest), its
    // members' USER# rows, its forms' FORM# rows and the listing row only where they name it, its PLUGIN# rows; its
    // AUDIT#WS# trail and slug guard stay (shared/ws_repo.py WorkspaceControlRows builds each key, tested).
    [DELETE_ROLE]: {
      scope: ['FORM#*', 'PLUGIN#*', 'USER#*', 'WORKSPACES', `WS#${ONE_WORKSPACE}`],
      why: 'a workspace\'s hard delete (decision 17): its control-plane rows, never its audit trail',
    },
    // A trial workspace's end (7.71.00, lib/stacks/trial-expiry.ts): it deletes nothing but this; a plugin's disable IS
    // the delete of its enable row (present = enabled), the key the existing route deletes. Configuration, not data.
    [TRIAL_EXPIRY_ROLE]: { scope: ['PLUGIN#*'], why: 'a paused trial\'s plugins: the existing disable of their PLUGIN# rows' },
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
  // Since 4d-2 also a hard delete's request, cancel and resume: its job row (WSDELETE), the platform's audit rows
  // (AUDIT#workspace-deletes), and META's and the listing row's status (lib/stacks/api-workspace-delete.ts: on
  // `WS#{one id}` exactly).
  'VocApiStack/WorkspacesLambdaRole': ['AUDIT#WS#*', 'AUDIT#workspace-deletes', 'PLUGIN#*', 'SLUG#*', 'USER#*',
    'WORKSPACES', 'WS#*', `WS#${ONE_WORKSPACE}`, 'WSDELETE'],
  // The hard delete itself: its job row, its completed audit row, the slug guard's deleted_at, the control rows.
  [DELETE_ROLE]: ['AUDIT#workspace-deletes', 'FORM#*', 'PLUGIN#*', 'SLUG#*', 'USER#*', 'WORKSPACES',
    `WS#${ONE_WORKSPACE}`, 'WSDELETE'],
  'VocApiStack/UsersLambdaRole': ['AUDIT#WS#*', 'USER#*', 'WS#*'],
  // With the hard delete on, the feedback processor counts the messages it drops for a deleting workspace on that
  // workspace's drop counter, `WS#{one id}` / `WSDELETE_DROPS` (UpdateItem of `dropped` alone, never a job row:
  // lambda/shared/workspace_deletes.py count_dropped).
  'VocProcessingStack/ProcessingLambdaRole': [`WS#${ONE_WORKSPACE}`],
  // A platform admin's entry into a workspace from a domain API: the stack's one workspace-resolution policy, attached
  // to each domain API's role that resolves (lib/utils/workspace-resolution-grants.ts): the settings API, and since
  // 7.04.00 the metrics API, the feedback edits and the integrations and scrapers APIs.
  'VocApiStack/WorkspaceResolutionPolicy': ['AUDIT#WS#*'],
  [RETENTION_ROLE]: ['WS#*'],
  // The feedback forms (7.06.00): a workspace form's lookup row (put on create, deleted with the form); its entry and
  // form_deleted audit rows go through the workspace-resolution policy above.
  'VocApiStack/FeedbackFormLambdaRole': ['FORM#*'],
  // A trial's end (7.71.00): its trial_paused and plugin_disabled audit rows, the `trial` map of META and the listing
  // row (attribute-limited), and a paused plugin's PLUGIN# row (its existing disable).
  [TRIAL_EXPIRY_ROLE]: ['AUDIT#WS#*', 'PLUGIN#*', 'WORKSPACES', 'WS#*'],
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
  // A workspace's export (docs/multi-workspace.md "Export and delete"): a derived copy of its feedback and members.
  'ws/*/exports/': ['ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/exports/ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/workspace-export.zip',
    'ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/exports/ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/work/cd-0'],
  'avatars/': ['avatars/persona_1_abc.png'],
  'prototypes/': ['prototypes/proj_1/doc_1.html'],
  'projects/*/product_docs/': ['projects/proj_1/product_docs/raw/doc.pdf', 'projects/proj_1/product_docs/extracted/doc.txt'],
  'company-context/': [
    'company-context/design/icons_abc.svg', 'company-context/design/logo_preview_abc.png', 'company-context/brief.md',
  ],
  'memory-imports/': ['memory-imports/imp_1.json'],
  // The Documents Library (7.62.00): an uploaded original and its extracted text, the deployment's and a workspace's.
  'library/': ['library/lib_20261101000000_0000a001/original', 'library/lib_20261101000000_0000a001/extracted'],
  'ws/*/library/': ['ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/library/lib_20261101000000_0000a001/original'],
};

/** Prefix → who may delete objects there (any S3 delete action, versions included). */
const RAW_BUCKET_DELETERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'raw/': { [RETENTION_ROLE]: 'erasure requests and declared retention limits (never the whole-upload archives)' },
  'silver/': { [RETENTION_ROLE]: 'every kept version of an erased or expired item, and a whole-source sweep' },
  // D5: an erasure by email and a retention window are legal obligations that reach every copy, a workspace's
  // included (the deployment's erasure, the deployment's source profiles a workspace's items are processed under; a
  // whole-source erasure never deletes there, in code: lambda/shared/retention.py `reaches_workspaces`).
  'ws/*/raw/': {
    [RETENTION_ROLE]: 'an erasure by email or a retention window reaches every raw version of a workspace\'s matching item',
    [DELETE_ROLE]: 'a workspace\'s hard delete (decision 17): every version under ws/{one id}/, after the items\' tombstones',
  },
  'ws/*/silver/': {
    [RETENTION_ROLE]: 'an erasure by email or a retention window reaches every kept version of a workspace\'s matching item',
    [DELETE_ROLE]: 'a workspace\'s hard delete (decision 17): every version under ws/{one id}/',
  },
  // D5: an export is a derived copy. The export job deletes only its own work objects (never a zip), when its row says
  // it may not go on (an erasure marked it erased): the rest expires by its tag.
  'ws/*/exports/': {
    [RETENTION_ROLE]: 'an erasure that reached a workspace deletes every version of its exports',
    'VocProcessingStack/WorkspaceExportWorkerExportRole': 'an export that may not go on deletes the work objects it wrote',
    [DELETE_ROLE]: 'a workspace\'s hard delete (decision 17): its exports go with it',
  },
  'avatars/': {
    [PROJECTS_API]: 'project / persona deletes and superseded avatars',
    [PERSONA_GENERATOR]: 'the avatars of the personas a replace removes',
  },
  'prototypes/': { [PROJECTS_API]: 'document and project deletes' },
  'projects/*/product_docs/': {
    [PROJECTS_API]: 'product-doc and project deletes',
    // 7.38.00: only `extracted/*` (its own output), only the version it just put, and only when the record was
    // deleted while it was being put (the document's delete had already swept it): never an upload.
    'VocCoreStack/ProductDocExtractorLambdaServiceRole': 'its own extracted text, of a record deleted mid-extraction',
  },
  'company-context/': { [SETTINGS_API]: 'the design-capture previews (icons_*, logo_preview_*) it replaces' },
  'memory-imports/': {},
  'library/': { [PROJECTS_API]: 'a library item\'s delete, by an admin or its uploader: every version of its objects' },
  'ws/*/library/': {
    [PROJECTS_API]: 'a workspace library item\'s delete, by its admin or its uploader: every version of its objects',
    [DELETE_ROLE]: 'a workspace\'s hard delete (decision 17): every version under ws/{one id}/',
  },
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

/** `<Stack>/<RoleId>` for a CDK default policy logical id (`<RoleId>DefaultPolicy<hash>`) or one CDK split off it
 *  (`<RoleId>OverflowPolicy<n><hash>`), `<Stack>/<PolicyId>` for a customer-managed policy's (`<PolicyId><hash>`). */
function roleOf(stack: string, policyId: string): string {
  return `${stack}/${policyId.replace(/(?:DefaultPolicy|OverflowPolicy\d+)?[0-9A-F]{8}$/, '')}`;
}

// With the hard delete on (-c workspaceHardDelete=true, lib/utils/workspace-hard-delete.ts): every role that can
// delete when a deployment turns it on. Off (the default), its job and grants are not built at all
// (workspace-delete-worker.test.ts, api-workspace-delete.test.ts).
const synthed = synthApp({}, undefined, HARD_DELETE_BUILD);
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

  it('voc-retention deletes only under raw/ and silver/ and each workspace\'s raw/, silver/ and exports/, never bucket-wide', () => {
    const rawDeletes = grants.filter((g) => g.role === RETENTION_ROLE && g.actions.some((a) => S3_DELETE.test(a)));
    // One workspace id per pattern (`ws_` + 26 `?`): `ws/*/raw/*` would also reach `ws/{ws}/silver/raw/…`.
    const ws = `ws/ws_${'?'.repeat(26)}`;
    expect(rawDeletes.flatMap(rawBucketGlobs).sort(byCodeUnit)).toStrictEqual(
      ['raw/*', 'silver/*', `${ws}/raw/*`, `${ws}/silver/*`, `${ws}/exports/*`].sort(byCodeUnit));
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
    // GetItem: a META's status only (grantWorkspaceStatusRead), before an erasure takes a workspace's export lock.
    // Query: the WORKSPACES listing only (7.43.00: an erasure by email walks every listed workspace's projects).
    expect([...new Set(onWorkspaces.flatMap((g) => g.actions))].sort(byCodeUnit))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem']);
    const update = onWorkspaces.find((g) => g.actions.includes('dynamodb:UpdateItem'));
    expect(update?.condition).toStrictEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*'] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['email', 'name', 'pk', 'sk'] },
      // 7.48.00: it asks for no returned values, so it cannot read a membership row back.
      StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] },
    });
  });

  it('voc-retention reaches voc-participants only through the participant erasure\'s calls, each on its partitions', () => {
    const walks = 'VocProcessingStack/RetentionWorkerRetentionWalksPolicy';
    const onParticipants = grants.filter((g) => g.role === RETENTION_ROLE || g.role === walks)
      .filter(onTable('ParticipantsTable'));
    // 7.72.00 (projects 3g2): no Scan, every statement pinned by LeadingKeys (lib/stacks/retention-worker.ts); the one
    // index read is the people index's Query, in the walks' policy, which holds no write.
    expect([...new Set(onParticipants.flatMap((g) => g.actions))].sort(byCodeUnit)).toStrictEqual([
      'dynamodb:BatchWriteItem', 'dynamodb:ConditionCheckItem', 'dynamodb:DeleteItem', 'dynamodb:GetItem',
      'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem',
    ]);
    expect(onParticipants.filter((g) => g.condition === undefined)).toStrictEqual([]);
    // Its only puts: the participant's tombstone and delete record (it is their audit writer there).
    expect(onParticipants.filter((g) => g.actions.includes('dynamodb:PutItem')).map(scopeOf))
      .toStrictEqual([['AUDIT#delete', 'AUDIT#tombstone#participant']]);
  });

  it('voc-retention\'s walks policy reads voc-participants only, its one index read the people index\'s Query', () => {
    const walks = 'VocProcessingStack/RetentionWorkerRetentionWalksPolicy';
    const onParticipants = grants.filter((g) => g.role === walks).filter(onTable('ParticipantsTable'));
    expect(onParticipants.filter((g) => g.resource.includes('/index/')).map((g) => g.actions))
      .toStrictEqual([['dynamodb:Query']]);
    expect(onParticipants.flatMap((g) => g.actions).filter((a) => DYNAMO_WRITE.test(a))).toStrictEqual([]);
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

describe('the Documents Library is reached by the projects API alone (7.62.00, docs/documents-library.md)', () => {
  const ITEM = 'lib_20261101000000_0000a001';
  const keys = (folder: string) => [`${folder}${ITEM}/original`, `${folder}${ITEM}/extracted`];
  const S3_ANY = /^s3:/;
  /** Every role holding any S3 action on a key of `samples`, by role. */
  const reachers = (samples: readonly string[]) => [...new Set(grants
    .filter((grant) => grant.actions.some((action) => S3_ANY.test(action)))
    .filter((grant) => rawBucketGlobs(grant).some((glob) => samples.some((key) => globMatches(glob, key))))
    .map((grant) => grant.role))].sort(byCodeUnit);

  // The admin data explorer reads the whole raw bucket by design (admins only, api/data_explorer_handler.py).
  const DATA_EXPLORER = 'VocApiStack/DataExplorerLambdaRole';
  // voc-retention's text read is in its erasure walks' managed policy, attached to its role (7.72.00).
  const RETENTION_WALKS = 'VocProcessingStack/RetentionWorkerRetentionWalksPolicy';

  it("the deployment's library: the projects API (and its assist twin, the same role), voc-retention's text read", () => {
    expect(reachers(keys('library/'))).toStrictEqual([DATA_EXPLORER, PROJECTS_API, RETENTION_WALKS].sort(byCodeUnit));
    // voc-retention reads the extracted text only, never an original (an erasure lists a match for review).
    expect(reachers([`library/${ITEM}/original`])).toStrictEqual([DATA_EXPLORER, PROJECTS_API].sort(byCodeUnit));
  });

  it("a workspace's library: the projects API, and the roles that hold the whole of one workspace's objects", () => {
    expect(reachers(keys('ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/library/'))).toStrictEqual([
      DATA_EXPLORER, PROJECTS_API, RETENTION_WALKS, 'VocProcessingStack/WorkspaceExportWorkerExportRole', DELETE_ROLE,
    ].sort(byCodeUnit));
  });

  it('no feedback role, metrics API or forms Lambda reaches it: a library item is never feedback (tenet 1)', () => {
    const everyone = reachers([...keys('library/'), ...keys('ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/library/')]);
    for (const role of everyone) {
      expect(role, role).not.toMatch(/Processor|Aggregator|Ingest|Metrics|FeedbackForm|Scraper|Plugin/i);
    }
  });
});
