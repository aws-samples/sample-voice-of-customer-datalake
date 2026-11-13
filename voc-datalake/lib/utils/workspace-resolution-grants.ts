/**
 * What a domain API Lambda needs to act in a workspace (lambda/shared/request_workspace.py, docs/multi-workspace.md
 * "Request flow", step 3), in these keys of voc-workspaces only (`dynamodb:LeadingKeys`):
 *
 * - GetItem on `WS#*`: the caller's `MEMBER#{sub}` row and the workspace's `META` (consistent reads);
 * - GetItem and PutItem on `AUDIT#WS#*`: a platform admin's entry audit row, written as a new row only and read back
 *   after a retried put (lambda/shared/audit_rows.py).
 *
 * No Query, Scan, UpdateItem or DeleteItem. The statements live in ONE customer-managed policy per stack, attached to
 * every role that resolves, so a domain API's inline policy does not grow by them (the inline quota,
 * api-stack-mcp.test.ts) and every domain API that moves into its workspace reuses it. The audit-row guard
 * (lib/utils/audit-row-guard.ts) guards it like a role's own policy: it names the policy a writer of `AUDIT#WS#*` only,
 * so the policy also carries the Denies on changing an audit row and on putting one in any other partition. The key
 * actions a write needs go on the role itself, beside its other grants on the same key. A role that attaches it
 * must not write voc-workspaces through its own policy too unless it is also named a writer of `AUDIT#WS#*` there:
 * the guard would give that role's own policy the Deny on every audit put, and an explicit Deny wins, so its
 * platform admins could no longer enter (platform-admin-writes.test.ts pins that the settings role writes nothing
 * there itself). The live platform-admin
 * check's Cognito grants (AdminListGroupsForUser, AdminGetUser) and `USER_POOL_ID` are the caller's to add, beside
 * the role's other uses of the pool.
 */
import * as cdk from 'aws-cdk-lib';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { KEY_ACTIONS_FOR_WRITE_ONLY_GRANT } from './table-write-grants';

/** A workspace's entry audit partition in voc-workspaces. */
export const WORKSPACE_AUDIT_PARTITION = 'AUDIT#WS#*';
/** The construct id of the stack's one workspace-resolution policy (the audit-row guard names it by this path). */
export const WORKSPACE_RESOLUTION_POLICY_ID = 'WorkspaceResolutionPolicy';

const leadingKeys = (partitions: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } });

/** The stack's workspace-resolution policy over `workspacesTable`, created on first use. */
function resolutionPolicy(scope: iam.Role, workspacesTable: dynamodb.ITable): iam.ManagedPolicy {
  const stack = cdk.Stack.of(scope);
  const existing = stack.node.tryFindChild(WORKSPACE_RESOLUTION_POLICY_ID);
  if (existing instanceof iam.ManagedPolicy) return existing;
  return new iam.ManagedPolicy(stack, WORKSPACE_RESOLUTION_POLICY_ID, {
    description: 'A domain API acting in a workspace: its membership reads and a platform admin\'s entry audit row',
    statements: [
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'], resources: [workspacesTable.tableArn],
        conditions: leadingKeys(['WS#*', WORKSPACE_AUDIT_PARTITION]),
      }),
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'], resources: [workspacesTable.tableArn],
        conditions: leadingKeys([WORKSPACE_AUDIT_PARTITION]),
      }),
    ],
  });
}

/** Every attribute the resolver projects (lambda/shared/workspace.py, since 7.09.00): MEMBER_READ_ATTRIBUTES of a
 *  `MEMBER#` row and META_READ_ATTRIBUTES of a `META`, so never a member's email (no `secret_status` since 7.12.00:
 *  a workspace's credentials need no secret, decision 19). */
const WORKSPACE_RESOLVER_ATTRIBUTES = ['pk', 'sk', 'role', 'status', 'name', 'slug'] as const;

/** Only the membership reads (GetItem on `WS#*`: the caller's `MEMBER#` row and `META`, held to the resolver's
 *  projections, {@link WORKSPACE_RESOLVER_ATTRIBUTES}), for a Lambda that resolves without a platform admin's entry
 *  (lambda/shared/request_workspace.py `elevate=False`): no audit row to write, so no PutItem. Returns the Lambda's
 *  `WORKSPACES_TABLE`. */
export function grantWorkspaceMembershipReads(workspacesTable: dynamodb.ITable, role: iam.Role): Record<string, string> {
  grantWorkspaceAttributeRead(role, workspacesTable, WORKSPACE_RESOLVER_ATTRIBUTES);
  return { WORKSPACES_TABLE: workspacesTable.tableName };
}

/** Grants `role` the workspace resolution's reads and its audit row; returns the Lambda's `WORKSPACES_TABLE`. */
export function grantWorkspaceResolution(workspacesTable: dynamodb.ITable, role: iam.Role): Record<string, string> {
  role.addManagedPolicy(resolutionPolicy(role, workspacesTable));
  workspacesTable.encryptionKey?.grant(role, ...KEY_ACTIONS_FOR_WRITE_ONLY_GRANT);
  return { WORKSPACES_TABLE: workspacesTable.tableName };
}

/** A `PLUGIN#{plugin}` / `WS#{ws}` row's key, the one attribute a check of whether a workspace enabled a plugin
 *  reads (lambda/shared/workspace_plugin_settings.py `require_plugin_enabled` projects `pk`): with
 *  {@link PLUGIN_ROW_PARTITIONS}, the attribute-limited read the operator APIs and the webhooks hold (7.14.00). */
export const PLUGIN_ROW_KEY = ['pk'] as const;
export const PLUGIN_ROW_PARTITIONS = ['PLUGIN#*'] as const;

/**
 * GetItem on voc-workspaces' `partitions` (default `WS#*`), held to `attributes` (`dynamodb:Attributes`, which must
 * be sent, and a projection required: `dynamodb:Select` `SPECIFIC_ATTRIBUTES` when it is sent), for a role that
 * reads a workspace's row without resolving a member through the policy above: the webhooks' routing read of a
 * `META` (lib/stacks/api-stack.ts), the MCP tokens' membership reads, and a `PLUGIN#` row's key
 * ({@link PLUGIN_ROW_KEY}). A role that attaches the policy needs none (the settings API's erasure routes read a
 * membership through it, lambda/shared/erasure_scope.py, with the resolver's projections, lambda/shared/workspace.py
 * MEMBER_READ_ATTRIBUTES and META_READ_ATTRIBUTES).
 */
export function grantWorkspaceAttributeRead(
  role: iam.Role, workspacesTable: dynamodb.ITable, attributes: readonly string[], partitions: readonly string[] = ['WS#*'],
): void {
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'], resources: [workspacesTable.tableArn],
    conditions: {
      ...leadingKeys([...partitions]),
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...attributes] },
      StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      // A GetItem that names no attributes carries no `dynamodb:Attributes`, which `ForAllValues` alone would let
      // through with the whole row: it is refused (every caller sends a projection).
      Null: { 'dynamodb:Attributes': 'false' },
    },
  }));
}

/**
 * The same resolution for a data-path or operator API whose role uses the user pool for nothing else (the metrics
 * API, the feedback edits, the integrations and scrapers APIs; lambda/shared/workspace_request.py): the stack's one
 * policy above, plus the live platform-admin check's Cognito `AdminListGroupsForUser` and `AdminGetUser` on the pool.
 * Returns the resolver's environment, `WORKSPACES_TABLE` and `USER_POOL_ID`.
 */
export function grantRequestWorkspace(
  workspacesTable: dynamodb.ITable, role: iam.Role, userPool: cognito.IUserPool,
): Record<string, string> {
  userPool.grant(role, 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser');
  return { ...grantWorkspaceResolution(workspacesTable, role), USER_POOL_ID: userPool.userPoolId };
}
