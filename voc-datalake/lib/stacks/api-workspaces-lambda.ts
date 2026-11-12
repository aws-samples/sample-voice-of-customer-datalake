/**
 * The workspaces API, `voc-workspaces-api` (VocApiStack, docs/multi-workspace.md; handler
 * lambda/api/workspaces_handler.py): the multi-workspace control plane, on GET, POST, PUT and DELETE /me/{proxy+}
 * (`/me/workspaces`, `/me/workspaces/current`, `/me/workspaces/current/members[/{sub}]`,
 * `/me/workspaces/current/plugins[/{plugin_id}]`) and GET + POST
 * /platform/{proxy+} (`/platform/workspaces`, platform admins only).
 *
 * Built ON the stack (stable logical id `WorkspacesApi…`, like every api-*.ts builder). Its own role:
 *   - voc-workspaces (VocCoreStack) only: Query (the caller's `USER#{sub}` rows, the `WORKSPACES` listing, a
 *     workspace's `MEMBER#` rows) and GetItem (a workspace's `META`, a `MEMBER#{sub}` row, an audit row read back
 *     after a retried put); PutItem only where the partition key matches the partitions a create writes, an add
 *     writes and an entry or a membership change audits ({@link WORKSPACE_WRITE_PARTITIONS}, `dynamodb:LeadingKeys`;
 *     a create or an add is one TransactWriteItems, authorised per item), every put conditional on a new key;
 *     UpdateItem on `WS#*` and `WORKSPACES` with the attribute `secret_status` only (a new workspace's `META` and
 *     listing row), and on `WS#*` and `USER#*` with the attribute `role` only (a role change); DeleteItem on `WS#*`
 *     and `USER#*` ({@link MEMBERSHIP_PARTITIONS}: a removal's `MEMBER#` and `USER#` rows; IAM cannot pin a sort key,
 *     so `META` in `WS#*` is in reach of IAM and kept out by the code) and on `PLUGIN#*` (a workspace's plugin
 *     disabled, lambda/shared/workspace_plugin_settings.py; no PutItem there until a workspace may enable one); ConditionCheckItem on `WS#*`. The audit-row
 *     guard (lib/utils/audit-row-guard.ts, which names this role the table's audit writer) denies it changing or
 *     removing an audit row. No BatchWriteItem or Scan;
 *   - Cognito AdminListGroupsForUser + AdminGetUser on the user pool: the live platform-admin check
 *     (lambda/shared/platform_admin.py); ListUsers (an email's account, a member's email by sub) and AdminCreateUser
 *     (a new member's account, the temporary password emailed): adding a member (lambda/shared/workspace_members.py);
 *   - Secrets Manager CreateSecret (only with the customer-managed key: `secretsmanager:KmsKeyArn`), DescribeSecret
 *     and TagResource on the per-workspace credentials secrets `voc/ws/*` (`<prefix>-voc/ws/*` in a prefixed
 *     deployment) and nothing else: one secret per workspace, made at run time (decision 8, about $0.40 a month
 *     each, the cost lib/test-support/fixed-cost-rules.ts names); the key itself through the role's KMS grant.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { WORKSPACE_SECRET_BASE_PREFIX, workspaceSecretsArn } from '../utils/workspace-secrets';
import type { ApiStackContext } from './api-context';

const WORKSPACES_API_FUNCTION_BASE_NAME = 'voc-workspaces-api';
const WORKSPACES_HANDLER_FILE = 'workspaces_handler.py';
/** Where the workspaces API puts (platform_workspaces.py, workspace.py, workspace_members.py): a create's rows, an
 * add's rows, the audits. Not `PLUGIN#*` yet: a workspace enables no plugin until phase 2's data path is in
 * (PER_WORKSPACE_INGESTION, lambda/shared/workspace_plugin_settings.py); the change that turns it on adds it back. */
const WORKSPACE_WRITE_PARTITIONS = ['AUDIT#WS#*', 'SLUG#*', 'USER#*', 'WORKSPACES', 'WS#*'];
/** A membership's two rows (lambda/shared/workspace_members.py): `WS#{ws}` / `MEMBER#{sub}` and `USER#{sub}` / `WS#{ws}`. */
const MEMBERSHIP_PARTITIONS = ['USER#*', 'WS#*'];
/** What the workspaces API deletes: a removal's two membership rows, and a disabled plugin's
 * `PLUGIN#{plugin}` / `WS#{ws}` row (lambda/shared/workspace_plugin_settings.py). */
const DELETE_PARTITIONS = ['PLUGIN#*', ...MEMBERSHIP_PARTITIONS];

/** Create, describe and tag the per-workspace credentials secrets, and no other secret. */
function grantWorkspaceSecrets(ctx: ApiStackContext, role: iam.Role, prefix: string): void {
  const { kmsKey } = ctx.props;
  const secretsArn = workspaceSecretsArn(ctx.stack, prefix);
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:CreateSecret'],
    resources: [secretsArn],
    // Only encrypted with the deployment's customer-managed key (decision 8).
    conditions: { StringEquals: { 'secretsmanager:KmsKeyArn': kmsKey.keyArn } },
  }));
  // DescribeSecret: a retried create keeps the secret it finds (lambda/shared/platform_workspaces.py); TagResource:
  // CreateSecret with Tags is also authorised as TagResource.
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:DescribeSecret', 'secretsmanager:TagResource'], resources: [secretsArn],
  }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'One credentials secret per workspace, made at run time and named from the server-generated workspace id '
      + '(voc/ws/{ws}/credentials, decision 8); the grant reaches only that name prefix of this deployment',
    findings: [resourceFinding(secretsArn)],
  }]);
}

/** The deployment's enabled plugins (lib/stacks/api-data-lambdas.ts `enabledSourcesEnv`): a workspace's ceiling. */
export interface WorkspacesInputs {
  readonly enabledSourcesEnv: string;
}

export function createWorkspacesLambda(ctx: ApiStackContext, inputs: WorkspacesInputs): lambda.Function {
  const { workspacesTable, kmsKey, userPool } = ctx.props;
  const functionName = ctx.uniqueName(WORKSPACES_API_FUNCTION_BASE_NAME);
  const secretPrefix = ctx.prefixed(WORKSPACE_SECRET_BASE_PREFIX);
  const role = ctx.role('WorkspacesLambdaRole');
  workspacesTable.grant(role, 'dynamodb:Query', 'dynamodb:GetItem');
  grantKeyScopedWrites(workspacesTable, role, ['PutItem'], WORKSPACE_WRITE_PARTITIONS);
  // The new workspace's META and its listing row (their secret_status, shared/platform_workspaces.py mark_secret_ready).
  // `secret_status` only (and the key the update names). IAM ORs this with the `role` grant below, and both name
  // `WS#*`, so IAM alone would allow `role` on META or `secret_status` on a MEMBER# row (no sort-key condition key
  // exists to split them); the code writes each attribute only where it belongs. Neither grant reaches any other
  // attribute (name, slug, status, invited_by, email…), nor SLUG#, AUDIT# or (for `role`) WORKSPACES.
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], ['WORKSPACES', 'WS#*'], ['pk', 'secret_status', 'sk']);
  // A member's role change (lambda/shared/workspace_members.py change_role): `role` alone on their MEMBER# and USER# rows.
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], MEMBERSHIP_PARTITIONS, ['pk', 'role', 'sk']);
  // A member's removal (remove_member): their MEMBER# and USER# rows. IAM pins only the partition key, so `WS#*` also
  // reaches that partition's META row; the code names MEMBER# keys only (tested), and SLUG#, WORKSPACES and AUDIT#
  // (the audit-row guard's Deny as well) stay out of reach.
  // A disabled plugin's row (shared/workspace_plugin_settings.py): `PLUGIN#{plugin}` / `WS#{ws}`, configuration.
  grantKeyScopedWrites(workspacesTable, role, ['DeleteItem'], DELETE_PARTITIONS);
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
  grantWorkspaceSecrets(ctx, role, secretPrefix);

  const environment: Record<string, string> = {
    WORKSPACES_TABLE: workspacesTable.tableName,
    USER_POOL_ID: userPool.userPoolId,
    KMS_KEY_ARN: kmsKey.keyArn,
    WORKSPACE_SECRET_PREFIX: secretPrefix,
    // The deployment's plugins (cdk.context.json): the ceiling a workspace picks its plugins from.
    ENABLED_SOURCES: inputs.enabledSourcesEnv,
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
    // voc-users-api's reads (lib/sizing/policy.ts); a create is one transaction and one CreateSecret; a member change
    // is up to two Cognito calls, a Query, an audit put and one transaction.
    memorySize: 512,
    timeout: cdk.Duration.seconds(10),
    logGroup: ctx.logGroup('WorkspacesApiLogs', functionName),
  });
}
