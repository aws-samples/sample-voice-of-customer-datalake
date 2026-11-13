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

/** Only the membership reads (GetItem on `WS#*`: the caller's `MEMBER#` row and `META`), for a Lambda that
 *  resolves without a platform admin's entry (lambda/shared/request_workspace.py `elevate=False`): no audit row to
 *  write, so no PutItem. Returns the Lambda's `WORKSPACES_TABLE`. */
export function grantWorkspaceMembershipReads(workspacesTable: dynamodb.ITable, role: iam.Role): Record<string, string> {
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [workspacesTable.tableArn],
    conditions: leadingKeys(['WS#*']),
  }));
  return { WORKSPACES_TABLE: workspacesTable.tableName };
}

/** Grants `role` the workspace resolution's reads and its audit row; returns the Lambda's `WORKSPACES_TABLE`. */
export function grantWorkspaceResolution(workspacesTable: dynamodb.ITable, role: iam.Role): Record<string, string> {
  role.addManagedPolicy(resolutionPolicy(role, workspacesTable));
  workspacesTable.encryptionKey?.grant(role, ...KEY_ACTIONS_FOR_WRITE_ONLY_GRANT);
  return { WORKSPACES_TABLE: workspacesTable.tableName };
}
