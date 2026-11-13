/**
 * The workspaces API, `voc-workspaces-api` (VocApiStack, docs/multi-workspace.md; handler
 * lambda/api/workspaces_handler.py): the multi-workspace control plane, on GET, POST, PUT and DELETE /me/{proxy+}
 * (`/me/workspaces`, `/me/workspaces/current`, `/me/workspaces/current/members[/{sub}]`) and GET + POST
 * /platform/{proxy+} (`/platform/workspaces`, platform admins only).
 *
 * Built ON the stack (stable logical id `WorkspacesApi…`, like every api-*.ts builder). Its own role:
 *   - voc-workspaces (VocCoreStack) only: Query (the caller's `USER#{sub}` rows, the `WORKSPACES` listing, a
 *     workspace's `MEMBER#` rows) and GetItem (a workspace's `META`, a `MEMBER#{sub}` row, an audit row read back
 *     after a retried put); PutItem only where the partition key matches the partitions a create writes, an add
 *     writes and an entry or a membership change audits ({@link WORKSPACE_WRITE_PARTITIONS}, `dynamodb:LeadingKeys`;
 *     a create or an add is one TransactWriteItems, authorised per item), every put conditional on a new key;
 *     UpdateItem on `WS#*` and `USER#*` with the attribute `role` only (a role change); DeleteItem on `WS#*`
 *     and `USER#*` ({@link MEMBERSHIP_PARTITIONS}: a removal's `MEMBER#` and `USER#` rows; IAM cannot pin a sort key,
 *     so `META` in `WS#*` is in reach of IAM and kept out by the code); ConditionCheckItem on `WS#*`. The audit-row
 *     guard (lib/utils/audit-row-guard.ts, which names this role the table's audit writer) denies it changing or
 *     removing an audit row. No BatchWriteItem or Scan;
 *   - Cognito AdminListGroupsForUser + AdminGetUser on the user pool: the live platform-admin check
 *     (lambda/shared/platform_admin.py); ListUsers (an email's account, a member's email by sub) and AdminCreateUser
 *     (a new member's account, the temporary password emailed): adding a member (lambda/shared/workspace_members.py);
 *   - no Secrets Manager and no SSM: since decision 19 a workspace's credentials are SSM parameters its first save
 *     makes (lib/utils/workspace-secrets.ts), so creating a workspace makes nothing but its rows, and costs nothing a
 *     month.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { grantKeyScopedWrites } from '../utils/table-write-grants';
import type { ApiStackContext } from './api-context';

const WORKSPACES_API_FUNCTION_BASE_NAME = 'voc-workspaces-api';
const WORKSPACES_HANDLER_FILE = 'workspaces_handler.py';
/** Where the workspaces API puts (platform_workspaces.py, workspace.py, workspace_members.py): a create's rows, an
 * add's rows, the audits. */
const WORKSPACE_WRITE_PARTITIONS = ['AUDIT#WS#*', 'SLUG#*', 'USER#*', 'WORKSPACES', 'WS#*'];
/** A membership's two rows (lambda/shared/workspace_members.py): `WS#{ws}` / `MEMBER#{sub}` and `USER#{sub}` / `WS#{ws}`. */
const MEMBERSHIP_PARTITIONS = ['USER#*', 'WS#*'];

export function createWorkspacesLambda(ctx: ApiStackContext): lambda.Function {
  const { workspacesTable, kmsKey, userPool } = ctx.props;
  const functionName = ctx.uniqueName(WORKSPACES_API_FUNCTION_BASE_NAME);
  const role = ctx.role('WorkspacesLambdaRole');
  workspacesTable.grant(role, 'dynamodb:Query', 'dynamodb:GetItem');
  grantKeyScopedWrites(workspacesTable, role, ['PutItem'], WORKSPACE_WRITE_PARTITIONS);
  // A member's role change (lambda/shared/workspace_members.py change_role): `role` alone on their MEMBER# and USER# rows
  // (IAM pins only the partition key, so `WS#*` also reaches META; the code writes `role` on MEMBER# rows only).
  // Nothing else is updated: a new workspace's META and listing row are written whole by its creation.
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], MEMBERSHIP_PARTITIONS, ['pk', 'role', 'sk']);
  // A member's removal (remove_member): their MEMBER# and USER# rows. IAM pins only the partition key, so `WS#*` also
  // reaches that partition's META row; the code names MEMBER# keys only (tested), and SLUG#, WORKSPACES and AUDIT#
  // (the audit-row guard's Deny as well) stay out of reach.
  grantKeyScopedWrites(workspacesTable, role, ['DeleteItem'], MEMBERSHIP_PARTITIONS);
  // A transaction's checks: the workspace is still active (an add), another member is still an admin (a demotion or
  // removal of an admin), both in `WS#*`. A ConditionCheck tests one item's condition and writes nothing.
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:ConditionCheckItem'],
    resources: [workspacesTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*'] } },
  }));
  kmsKey.grantEncryptDecrypt(role);
  // The live platform-admin check (lambda/shared/platform_admin.py): the caller's groups and enabled state; adding a
  // member (workspace_members.py): find the email's account (ListUsers, filtered on the email or a member's sub) or
  // create it (AdminCreateUser, which emails the temporary password).
  userPool.grant(role, 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser', 'cognito-idp:ListUsers',
    'cognito-idp:AdminCreateUser');

  const environment: Record<string, string> = {
    WORKSPACES_TABLE: workspacesTable.tableName,
    USER_POOL_ID: userPool.userPoolId,
    ALLOWED_ORIGIN: ctx.allowedOrigin,
    POWERTOOLS_SERVICE_NAME: WORKSPACES_API_FUNCTION_BASE_NAME,
    LOG_LEVEL: 'INFO',
  };
  return new lambda.Function(ctx.stack, 'WorkspacesApi', {
    functionName,
    role,
    environment,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: WORKSPACES_HANDLER_FILE.replace(/\.py$/, '.lambda_handler'),
    code: ctx.apiCode(WORKSPACES_HANDLER_FILE),
    layers: [ctx.apiLayer],
    // The first call after sign-in: one Query or two GetItems (and, for a platform admin, two Cognito look-ups), like
    // voc-users-api's reads (lib/sizing/policy.ts); a create is one transaction; a member change
    // is up to two Cognito calls, a Query, an audit put and one transaction.
    memorySize: 512,
    timeout: cdk.Duration.seconds(10),
    logGroup: ctx.logGroup('WorkspacesApiLogs', functionName),
  });
}
