/**
 * What a data-path API needs to resolve a request's `X-Workspace-Id` (docs/multi-workspace.md, "Request flow";
 * lambda/shared/workspace_request.py over lambda/shared/workspace.py `resolve_workspace`): the metrics API and the
 * feedback edits.
 *
 *   - voc-workspaces (VocCoreStack): GetItem on `WS#*` (the caller's `MEMBER#` row, the workspace's `META`) and
 *     `AUDIT#WS#*` (an entry audit row read back after a retried put, lambda/shared/audit_rows.py); PutItem on
 *     `AUDIT#WS#*` only (a platform admin's entry, kind `platform_admin_entry`; the audit-row guard,
 *     lib/utils/audit-row-guard.ts, names these roles writers of that partition only). `dynamodb:LeadingKeys` on
 *     both; no Query, UpdateItem, DeleteItem, BatchWriteItem or Scan: the table is read-only for these roles but for
 *     that one audit row, as for the workspaces API's reads;
 *   - Cognito AdminListGroupsForUser + AdminGetUser on the user pool: the live platform-admin check
 *     (lambda/shared/platform_admin.py), run on a cache fill that would elevate a platform admin;
 *   - the environment the resolver reads: `WORKSPACES_TABLE`, `USER_POOL_ID`.
 * The key of voc-workspaces is the customer-managed key every role here already holds.
 */
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

import { grantKeyScopedWrites } from './table-write-grants';

/** A workspace's audit partition: the only one these roles write in voc-workspaces. */
const WORKSPACE_AUDIT_PARTITION = 'AUDIT#WS#*';
/** The partitions these roles read in voc-workspaces (`WS#{ws}`'s META and MEMBER# rows, an entry audit row). */
const WORKSPACE_RESOLUTION_READS = [WORKSPACE_AUDIT_PARTITION, 'WS#*'];

export function grantWorkspaceResolution(
  role: iam.Role, workspacesTable: dynamodb.ITable, userPool: cognito.IUserPool,
): void {
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [workspacesTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...WORKSPACE_RESOLUTION_READS] } },
  }));
  grantKeyScopedWrites(workspacesTable, role, ['PutItem'], [WORKSPACE_AUDIT_PARTITION]);
  userPool.grant(role, 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser');
}

/** The resolver's environment (lambda/shared/workspace_request.py, lambda/shared/tables.py). */
export function workspaceResolutionEnv(
  workspacesTable: dynamodb.ITable, userPool: cognito.IUserPool,
): Record<string, string> {
  return { WORKSPACES_TABLE: workspacesTable.tableName, USER_POOL_ID: userPool.userPoolId };
}
