/**
 * Audit rows can be changed or removed by no role, and written only by their writer (TENETS.md D4; wave C owner
 * decision 4: audit trails never expire, and only their writer can write them).
 *
 * Audit, tombstone and delete-record rows live under partition keys that start with `AUDIT#`, in the tables that
 * hold them ({@link AuditRowTables}): voc-aggregates (`AUDIT#retention`, `AUDIT#tombstone#<source>`, written by
 * voc-retention; `AUDIT#delete` for a design reference's copies, written by the settings API; `AUDIT#platform-admins`,
 * a grant or revoke of the platform-admins group, written by the users API) and voc-projects /
 * voc-participants / voc-feature-requests / voc-conversations (`AUDIT#delete`, written by the API that deletes the
 * artifact, lambda/shared/delete_audit.py, which only PUTs a new row) and voc-workspaces (`AUDIT#WS#<ws>`, a platform
 * admin's entry into a workspace, the workspace's creation and its membership changes, written by the workspaces
 * API, lambda/shared/workspace.py, platform_workspaces.py and workspace_members.py; a deleted user's membership
 * removals, written by the users API, `AUDIT#WS#*` only; a platform admin's entry through the metrics API or the
 * feedback edits, each `AUDIT#WS#*` only; a workspace's hard delete, voc-workspace-delete: its tombstones,
 * `AUDIT#tombstone#*` only, in voc-aggregates, and `AUDIT#workspace-deletes` only in voc-workspaces, where the
 * workspaces API writes that partition's request and cancel rows). Every role that can write in one of those
 * tables gets, on it, an explicit Deny pinned by `dynamodb:LeadingKeys` to `AUDIT#*`:
 *
 *   - a table the role is that table's audit writer for: Deny DeleteItem, UpdateItem and BatchWriteItem (no audit
 *     row is ever changed or removed, a batch delete included; every writer puts its rows one PutItem at a time);
 *   - every other table it writes: ONE Deny of those actions plus PutItem (it cannot forge, overwrite, change or
 *     remove one). Each table's ARN appears in one of the two statements only, to keep the policies small;
 *   - a writer limited to one audit partition (the settings API's `AUDIT#delete` and the users API's
 *     `AUDIT#platform-admins` in voc-aggregates; the users API's `AUDIT#WS#*` in voc-workspaces, a pattern): Deny
 *     PutItem and BatchWriteItem on every OTHER audit partition (it cannot forge a retention row or a tombstone).
 *
 * The audit writers are NAMED ({@link AUDIT_WRITERS}: the role that runs the code writing that table's audit rows),
 * not inferred from the grants: a role that can delete in a table (the verification fixture provider, an operational
 * cleanup) is not thereby allowed to write its audit trail. An explicit Deny wins over every Allow, so a later broad
 * grant cannot reopen the rows.
 *
 * `ForAnyValue:StringLike`, not `ForAllValues`: in a Deny, `ForAllValues` would let a batch that mixes one audit key
 * with any other key through; `ForAnyValue` denies the request when ANY partition key it names matches, and is
 * false when the request names none (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-single-vs-multi-valued-context-keys.html,
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html). The one-partition
 * Deny adds `ForAnyValue:StringNotEquals` on that partition (both operators must hold): a key that is an audit key
 * and not the writer's own is refused.
 *
 * Inline, on each role's default policy (at most three statements, the tables it writes), not a managed policy per
 * stack: no new resource against the VocApiStack ceiling, and the size stays far under the 10,240-character inline
 * quota (api-stack-mcp.test.ts). Applied by applyAppAspects (lib/utils/app-aspects.ts), after every grant and before
 * the exact-grants rewrite, in bin/ and in every per-stack test fixture.
 */
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';
import { z } from 'zod';

/** The partition-key pattern of every audit row. */
const AUDIT_PARTITION_PATTERN = 'AUDIT#*';
/** Sids of the statements this module adds. */
export const AUDIT_DENY_CHANGE_SID = 'DenyAuditRowChanges';
export const AUDIT_DENY_WRITE_SID = 'DenyAuditRowWritesByNonWriters';
export const AUDIT_DENY_OTHER_PARTITION_SID = 'DenyAuditRowWritesOutsideOwnPartition';

const WRITE_ACTIONS = new Set(['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem', 'dynamodb:*']);

/** The tables that hold `AUDIT#*` rows, named like VocCoreStack's properties (a stack or a fixture's props fit). */
export interface AuditRowTables {
  readonly aggregatesTable?: dynamodb.ITable;
  readonly projectsTable?: dynamodb.ITable;
  readonly participantsTable?: dynamodb.ITable;
  readonly featureRequestsTable?: dynamodb.ITable;
  readonly conversationsTable?: dynamodb.ITable;
  readonly workspacesTable?: dynamodb.ITable;
}

/** An audit writer of one table, by the construct-path suffix of its role. */
export interface NamedAuditWriter {
  readonly table: dynamodb.ITable;
  readonly rolePathSuffixes: readonly string[];
  /** The one audit partition it may put; absent = any `AUDIT#*` partition. */
  readonly partitionKey?: string;
}

export interface AuditGuardOptions {
  readonly tables: readonly dynamodb.ITable[];
  readonly writers: readonly NamedAuditWriter[];
}

/** Every audit writer, per table (lambda/shared/delete_audit.py's callers, voc-retention, shared/workspace.py). Each entry is pinned over
 *  the whole app by audit-row-guard.test.ts. */
const AUDIT_WRITERS: readonly { readonly table: keyof AuditRowTables; readonly rolePathSuffix: string;
  readonly partitionKey?: string }[] = [
  // voc-retention: AUDIT#retention (run rows) and AUDIT#tombstone#<source> (one per deleted item, batched).
  { table: 'aggregatesTable', rolePathSuffix: '/RetentionWorker/RetentionRole' },
  // The settings API (and its assist twin, same role): the AUDIT#delete row of an archived design reference's copies.
  { table: 'aggregatesTable', rolePathSuffix: '/SettingsLambdaRole', partitionKey: 'AUDIT#delete' },
  // The users API: a grant or revoke of the platform-admins group (AUDIT#platform-admins, lambda/api/users_handler.py).
  { table: 'aggregatesTable', rolePathSuffix: '/UsersLambdaRole', partitionKey: 'AUDIT#platform-admins' },
  // Project, persona, document, revision, product doc and comment deletes (the projects API and its assist twin);
  // a replace regeneration's removed personas (the persona generator).
  { table: 'projectsTable', rolePathSuffix: '/ProjectsLambdaRole' },
  { table: 'projectsTable', rolePathSuffix: '/PersonaGeneratorRole' },
  // Lists, people (participant erasure tombstones too), boards, requests and +1s.
  { table: 'participantsTable', rolePathSuffix: '/EngagementLambdaRole' },
  { table: 'featureRequestsTable', rolePathSuffix: '/EngagementLambdaRole' },
  // A deleted conversation.
  { table: 'conversationsTable', rolePathSuffix: '/ChatLambdaRole' },
  // A platform admin's entry into a workspace and a workspace's creation (AUDIT#WS#<ws>; the only audit partitions
  // its PutItem's LeadingKeys reach, lib/stacks/api-workspaces-lambda.ts).
  { table: 'workspacesTable', rolePathSuffix: '/WorkspacesLambdaRole' },
  // The users API: the member_removed rows of a deleted user's memberships (AUDIT#WS#<ws> only,
  // lambda/shared/workspace_members.py remove_user_memberships; lib/stacks/api-engagement-lambdas.ts).
  { table: 'workspacesTable', rolePathSuffix: '/UsersLambdaRole', partitionKey: 'AUDIT#WS#*' },
  // The data-path APIs that resolve X-Workspace-Id (lambda/shared/workspace_request.py): a platform admin's entry
  // into a workspace (AUDIT#WS#<ws> only; lib/utils/workspace-request-grants.ts).
  { table: 'workspacesTable', rolePathSuffix: '/MetricsLambdaRole', partitionKey: 'AUDIT#WS#*' },
  { table: 'workspacesTable', rolePathSuffix: '/FeedbackEditLambdaRole', partitionKey: 'AUDIT#WS#*' },
  // The operator APIs that resolve it too (Run now, scraper runs, the breaker, a workspace's credentials).
  { table: 'workspacesTable', rolePathSuffix: '/IntegrationsLambdaRole', partitionKey: 'AUDIT#WS#*' },
  { table: 'workspacesTable', rolePathSuffix: '/ScrapersLambdaRole', partitionKey: 'AUDIT#WS#*' },
  // The feedback forms' signed-in routes resolve it too (a workspace's forms; lib/stacks/api-engagement-lambdas.ts).
  { table: 'workspacesTable', rolePathSuffix: '/FeedbackFormLambdaRole', partitionKey: 'AUDIT#WS#*' },
  // A workspace's hard delete (lib/stacks/workspace-delete-worker.ts): one tombstone per deleted item and memory
  // (AUDIT#tombstone#<source>, AUDIT#tombstone#memory: a conditional put of a new key, shared/ws_repo.py
  // WorkspaceTombstones), and the platform's completed row (AUDIT#workspace-deletes).
  { table: 'aggregatesTable', rolePathSuffix: '/WorkspaceDeleteWorker/DeleteRole', partitionKey: 'AUDIT#tombstone#*' },
  { table: 'workspacesTable', rolePathSuffix: '/WorkspaceDeleteWorker/DeleteRole',
    partitionKey: 'AUDIT#workspace-deletes' },
];

const TABLE_KEYS = ['aggregatesTable', 'projectsTable', 'participantsTable', 'featureRequestsTable',
  'conversationsTable', 'workspacesTable'] as const satisfies readonly (keyof AuditRowTables)[];

/** The guard options for the audit tables `tables` names (the tables it leaves out are not guarded). */
export function auditRowGuardFor(tables: AuditRowTables): AuditGuardOptions {
  const writers = AUDIT_WRITERS.flatMap((writer) => {
    const table = tables[writer.table];
    return table === undefined ? [] : [{ table, rolePathSuffixes: [writer.rolePathSuffix], partitionKey: writer.partitionKey }];
  });
  return { tables: TABLE_KEYS.flatMap((key) => tables[key] ?? []), writers };
}

const StatementSchema = z.looseObject({
  Effect: z.string().optional(),
  Action: z.union([z.string(), z.array(z.string())]).optional(),
  Resource: z.union([z.string(), z.array(z.unknown())]).optional(),
  Condition: z.unknown().optional(),
});
const DocumentSchema = z.looseObject({ Statement: z.array(z.unknown()).optional() }).optional();

/** The guarded table ARNs one Allow statement writes, or none. */
function tablesWritten(statement: z.infer<typeof StatementSchema>, tableArns: ReadonlySet<string>): string[] {
  const actions = [statement.Action ?? []].flat();
  if ((statement.Effect ?? 'Allow') !== 'Allow' || !actions.some((action) => WRITE_ACTIONS.has(action))) return [];
  return [statement.Resource ?? []].flat()
    .filter((resource): resource is string => typeof resource === 'string' && tableArns.has(resource));
}

/** The guarded tables (by their ARN tokens) a role's default policy writes. */
function writtenTables(policy: iam.Policy, tableArns: ReadonlySet<string>): Set<string> {
  const statements = DocumentSchema.parse(policy.document.toJSON())?.Statement ?? [];
  return new Set(statements.flatMap((raw) => tablesWritten(StatementSchema.parse(raw), tableArns)));
}

const AUDIT_KEYS = { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': [AUDIT_PARTITION_PATTERN] } };

const denyOnAuditRows = (sid: string, actions: string[], resources: string[], conditions: Record<string, unknown> = AUDIT_KEYS) =>
  new iam.PolicyStatement({ sid, effect: iam.Effect.DENY, actions, resources, conditions });

const PUT_ACTIONS = ['dynamodb:PutItem', 'dynamodb:BatchWriteItem'];
/**
 * What no role may do to an audit row, writers included. BatchWriteItem too: IAM checks a batch as BatchWriteItem, so
 * a DeleteRequest inside it is NOT checked as DeleteItem; every audit writer puts its rows one PutItem at a time
 * (lambda/shared/delete_audit.py, participants_erasure.py, workspace.py, jobs/retention/copies.py) or as one Put of a
 * transaction, which IAM checks as PutItem (platform_workspaces.py, a workspace's creation), so none needs a batch there.
 * PartiQL is not listed: no role is granted a PartiQL action (grantReadWriteData and the exact grants hold none).
 */
const CHANGE_ACTIONS = ['dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem'];

/** What a role may put in each table it writes: every audit partition, one, or none. */
type PutRight = { readonly kind: 'any' } | { readonly kind: 'one'; readonly partitionKey: string } | { readonly kind: 'none' };

function putRight(role: iam.Role, arn: string, writers: readonly NamedAuditWriter[]): PutRight {
  const named = writers.find((writer) => writer.table.tableArn === arn
    && writer.rolePathSuffixes.some((suffix) => role.node.path.endsWith(suffix)));
  if (named === undefined) return { kind: 'none' };
  return named.partitionKey === undefined ? { kind: 'any' } : { kind: 'one', partitionKey: named.partitionKey };
}

/** Add the audit-row Denies to one role (see the module comment). Each guarded table appears in ONE of the first two
 *  statements, so its ARN is written once (the projects API's inline policy is close to the 70% size check): */
function guardRole(role: iam.Role, written: ReadonlySet<string>, writers: readonly NamedAuditWriter[]): void {
  const rights = [...written].map((arn) => ({ arn, right: putRight(role, arn, writers) }));
  //  - the tables it writes audit rows in: no change, no delete (a batch included);
  const writes = rights.filter(({ right }) => right.kind !== 'none').map(({ arn }) => arn);
  if (writes.length > 0) role.addToPrincipalPolicy(denyOnAuditRows(AUDIT_DENY_CHANGE_SID, CHANGE_ACTIONS, writes));
  //  - the tables it does not: no put either (it cannot forge or overwrite a row);
  const none = rights.filter(({ right }) => right.kind === 'none').map(({ arn }) => arn);
  if (none.length > 0) {
    role.addToPrincipalPolicy(denyOnAuditRows(AUDIT_DENY_WRITE_SID, [...new Set([...CHANGE_ACTIONS, ...PUT_ACTIONS])],
      none));
  }
  //  - a writer limited to one partition: no put on any other audit partition. A pattern (`AUDIT#WS#*`, one
  //    workspace's audit partition each) is matched with StringNotLike, an exact key with StringNotEquals. A role
  //    limited in two tables gets one statement per table, the second Sid numbered (Sids are unique in a policy).
  const limited = rights.flatMap(({ arn, right }) => (right.kind === 'one' ? [{ arn, partitionKey: right.partitionKey }] : []));
  limited.forEach(({ arn, partitionKey }, index) => {
    const operator = partitionKey.includes('*') ? 'ForAnyValue:StringNotLike' : 'ForAnyValue:StringNotEquals';
    const sid = index === 0 ? AUDIT_DENY_OTHER_PARTITION_SID : `${AUDIT_DENY_OTHER_PARTITION_SID}${index + 1}`;
    role.addToPrincipalPolicy(denyOnAuditRows(sid, PUT_ACTIONS, [arn], {
      ...AUDIT_KEYS,
      [operator]: { 'dynamodb:LeadingKeys': [partitionKey] },
    }));
  });
}

/** Add the audit-row Denies to every role under `scope` that writes a guarded table (see the module comment). */
export function applyAuditRowGuard(scope: IConstruct, options: AuditGuardOptions): void {
  const tableArns = new Set(options.tables.map((table) => table.tableArn));
  if (tableArns.size === 0) return;
  const roles = scope.node.findAll().filter((construct): construct is iam.Role => construct instanceof iam.Role);
  for (const role of roles) {
    const policy = role.node.tryFindChild('DefaultPolicy');
    if (!(policy instanceof iam.Policy)) continue;
    const written = writtenTables(policy, tableArns);
    if (written.size > 0) guardRole(role, written, options.writers);
  }
}
