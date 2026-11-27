/**
 * The workspaces API, `voc-workspaces-api` (VocApiStack, docs/multi-workspace.md; handler
 * lambda/api/workspaces_handler.py): the multi-workspace control plane, on GET, POST, PUT and DELETE /me/{proxy+}
 * (`/me/workspaces`, `/me/workspaces/current` (GET, and PUT: a rename), `/me/workspaces/current/members[/{sub}]`,
 * `/me/workspaces/current/plugins[/{plugin_id}]`) and GET + POST
 * /platform/{proxy+} (`/platform/workspaces`, platform admins only).
 *
 * Built ON the stack (stable logical id `WorkspacesApi…`, like every api-*.ts builder). Its own role:
 *   - voc-workspaces (VocCoreStack) only: Query (the caller's `USER#{sub}` rows, the `WORKSPACES` listing, a
 *     workspace's `MEMBER#` rows) and GetItem (a workspace's `META`, a `MEMBER#{sub}` row, an audit row read back
 *     after a retried put); PutItem only where the partition key matches the partitions a create writes, an add
 *     writes and an entry or a membership change audits ({@link WORKSPACE_WRITE_PARTITIONS}, `dynamodb:LeadingKeys`;
 *     a create or an add is one TransactWriteItems, authorised per item), every put conditional on a new key;
 *     UpdateItem on `WS#*` and `USER#*` with the attribute `role` only (a role change), or `name` only (a rename:
 *     META and the members' `USER#` rows); DeleteItem on `WORKSPACES` (a rename's old listing row), `WS#*`
 *     and `USER#*` ({@link MEMBERSHIP_PARTITIONS}: a removal's `MEMBER#` and `USER#` rows; IAM cannot pin a sort key,
 *     so `META` in `WS#*` is in reach of IAM and kept out by the code) and on `PLUGIN#*` (a workspace's plugin
 *     disabled, lambda/shared/workspace_plugin_settings.py; its PutItem there, since 7.14.00, is the enable); ConditionCheckItem on `WS#*`. The audit-row
 *     guard (lib/utils/audit-row-guard.ts, which names this role the table's audit writer) denies it changing or
 *     removing an audit row. No BatchWriteItem or Scan;
 *   - voc-aggregates: Query of the cost rows only (`WS#<one id>#COST`, `DEPLOYMENT#COST`, `UNATTRIBUTED#COST`,
 *     `dynamodb:LeadingKeys`; GET /platform/costs, platform admins);
 *   - Cognito AdminListGroupsForUser + AdminGetUser on the user pool: the live platform-admin check
 *     (lambda/shared/platform_admin.py); ListUsers (an email's account, a member's email by sub) and AdminCreateUser
 *     (a new member's account, the temporary password emailed): adding a member (lambda/shared/workspace_members.py);
 *   - with `-c emailFrom` only (lib/utils/email-sender.ts): `ses:SendEmail` from exactly that address, the
 *     participants role's grant, for the notice an existing account gets when it is added to a workspace
 *     (lambda/shared/member_notice.py), and EMAIL_FROM and FRONTEND_URL (the link's origin); without it neither;
 *   - no Secrets Manager and no SSM: since decision 19 a workspace's credentials are SSM parameters its first save
 *     makes (lib/utils/workspace-secrets.ts), so creating a workspace makes nothing but its rows, and costs nothing a
 *     month;
 *   - a trial workspace (7.71.00, lambda/shared/trials.py; {@link grantTrialWrites}): UpdateItem of `trial` alone
 *     on META and the listing row (`WS#*`, `WORKSPACES`); and, for an extension or a conversion of a paused trial,
 *     GetItem of a workspace's form (the publish rules asked again) and UpdateItem of its `enabled`, `write_count`,
 *     `updated_at` and `updated_by` in voc-aggregates (`WS#<one id>#FEEDBACK_FORM`). Nothing is scheduled: the expiry's
 *     hourly tick reads the ends from the listing (lib/stacks/trial-expiry.ts). Statements on this role only: no
 *     VocApiStack resource (api-engagement-budget.test.ts).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { emailSenderOf, sesSendStatement } from '../utils/email-sender';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import type { ApiStackContext } from './api-context';
import { COST_PARTITIONS } from './cost-rollup-worker';
import { TRIAL_ATTRIBUTES, TRIAL_FORM_ATTRIBUTES, TRIAL_FORM_PARTITIONS } from './trial-expiry';

const WORKSPACES_API_FUNCTION_BASE_NAME = 'voc-workspaces-api';
const WORKSPACES_HANDLER_FILE = 'workspaces_handler.py';
/** Where the workspaces API puts (platform_workspaces.py, workspace.py, workspace_members.py,
 * workspace_plugin_settings.py): a create's rows, an add's rows, the audits, and since 7.14.00 an enabled plugin's
 * `PLUGIN#{plugin}` / `WS#{ws}` row (the partition the plugin's scheduled ingestor fans out over). */
const WORKSPACE_WRITE_PARTITIONS = ['AUDIT#WS#*', 'PLUGIN#*', 'SLUG#*', 'USER#*', 'WORKSPACES', 'WS#*'];
/** A membership's two rows (lambda/shared/workspace_members.py): `WS#{ws}` / `MEMBER#{sub}` and `USER#{sub}` / `WS#{ws}`. */
const MEMBERSHIP_PARTITIONS = ['USER#*', 'WS#*'];
/** What the workspaces API deletes: a removal's two membership rows, a disabled plugin's
 * `PLUGIN#{plugin}` / `WS#{ws}` row (lambda/shared/workspace_plugin_settings.py), and a renamed workspace's old listing
 * row `WORKSPACES` / `{old name}#{ws}` (lambda/shared/workspace_rename.py, which puts it again under the new name). */
const DELETE_PARTITIONS = ['PLUGIN#*', 'WORKSPACES', ...MEMBERSHIP_PARTITIONS];

/** The deployment's enabled plugins (lib/stacks/api-data-lambdas.ts `enabledSourcesEnv`): a workspace's ceiling. */
export interface WorkspacesInputs {
  readonly enabledSourcesEnv: string;
}

/** A trial's writes (see the module's doc): its map, and a paused trial's forms read and turned back on. */
function grantTrialWrites(ctx: ApiStackContext, role: iam.Role): void {
  const { workspacesTable, aggregatesTable } = ctx.props;
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], ['WORKSPACES', 'WS#*'], TRIAL_ATTRIBUTES,
    { noReturnValues: true });
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'TrialFormsRead', actions: ['dynamodb:GetItem'], resources: [aggregatesTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...TRIAL_FORM_PARTITIONS] } },
  }));
  grantKeyScopedWrites(aggregatesTable, role, ['UpdateItem'], TRIAL_FORM_PARTITIONS, TRIAL_FORM_ATTRIBUTES,
    { noReturnValues: true });
}

export function createWorkspacesLambda(ctx: ApiStackContext, inputs: WorkspacesInputs): lambda.Function {
  const { workspacesTable, aggregatesTable, kmsKey, userPool } = ctx.props;
  const functionName = ctx.uniqueName(WORKSPACES_API_FUNCTION_BASE_NAME);
  const role = ctx.role('WorkspacesLambdaRole');
  workspacesTable.grant(role, 'dynamodb:Query', 'dynamodb:GetItem');
  grantKeyScopedWrites(workspacesTable, role, ['PutItem'], WORKSPACE_WRITE_PARTITIONS);
  // A member's role change (lambda/shared/workspace_members.py change_role): `role` alone on their MEMBER# and USER# rows
  // (IAM pins only the partition key, so `WS#*` also reaches META; the code writes `role` on MEMBER# rows only).
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], MEMBERSHIP_PARTITIONS, ['pk', 'role', 'sk']);
  // A rename (lambda/shared/workspace_rename.py): `name` alone on the workspace's META row and each member's USER# row
  // (its listing row is moved by a delete and a put, above and below).
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], MEMBERSHIP_PARTITIONS, ['name', 'pk', 'sk']);
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
  // GET /platform/costs (lambda/shared/platform_costs.py): a Query of the cost rows only, a workspace's
  // (`WS#<one id>#COST`), the deployment's and the unattributed ones, in voc-aggregates.
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'QueryCostRows',
    actions: ['dynamodb:Query'],
    resources: [aggregatesTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': COST_PARTITIONS } },
  }));
  // The live platform-admin check (lambda/shared/platform_admin.py): the caller's groups and enabled state; adding a
  // member (workspace_members.py): find the email's account (ListUsers, filtered on the email or a member's sub) or
  // create it (AdminCreateUser, which emails the temporary password).
  userPool.grant(role, 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser', 'cognito-idp:ListUsers',
    'cognito-idp:AdminCreateUser');
  grantTrialWrites(ctx, role);
  // With -c emailFrom: the notice an existing account gets when it is added to a workspace
  // (lambda/shared/member_notice.py), from exactly that address. Its daily guard row, `WS#{ws}` / `NOTICE#{sub}`, is a
  // conditional put in `WS#*`, already in WORKSPACE_WRITE_PARTITIONS (IAM pins the partition, not the sort key).
  const sender = emailSenderOf(ctx.stack.node);
  if (sender !== undefined) role.addToPolicy(sesSendStatement(ctx.stack, sender));

  const environment: Record<string, string> = {
    WORKSPACES_TABLE: workspacesTable.tableName,
    // The cost rows (GET /platform/costs); the export routes read their job rows there too (api-workspace-export.ts).
    AGGREGATES_TABLE: aggregatesTable.tableName,
    USER_POOL_ID: userPool.userPoolId,
    // The deployment's plugins (cdk.context.json): the ceiling a workspace picks its plugins from.
    ENABLED_SOURCES: inputs.enabledSourcesEnv,
    ALLOWED_ORIGIN: ctx.allowedOrigin,
    POWERTOOLS_SERVICE_NAME: WORKSPACES_API_FUNCTION_BASE_NAME,
    LOG_LEVEL: 'INFO',
    // The notice's sender and its link's origin (`{FRONTEND_URL}/workspace/{slug}/`): only with -c emailFrom.
    ...(sender === undefined ? {} : {
      EMAIL_FROM: sender.address,
      FRONTEND_URL: `https://${ctx.props.frontendDomainName}`,
    }),
  };
  return new lambda.Function(ctx.stack, 'WorkspacesApi', {
    functionName,
    role,
    environment,
    runtime: lambda.Runtime.PYTHON_3_15,
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
