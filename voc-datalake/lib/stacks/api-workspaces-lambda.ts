/**
 * The workspaces API, `voc-workspaces-api` (VocApiStack, docs/multi-workspace.md; handler
 * lambda/api/workspaces_handler.py): the multi-workspace control plane, on GET /me/{proxy+} (`/me/workspaces`,
 * `/me/workspaces/current`) and GET + POST /platform/{proxy+} (`/platform/workspaces`, platform admins only).
 *
 * Built ON the stack (stable logical id `WorkspacesApi…`, like every api-*.ts builder). Its own role:
 *   - voc-workspaces (VocCoreStack) only: Query (the caller's `USER#{sub}` rows, the `WORKSPACES` listing) and
 *     GetItem (a workspace's `META`, the caller's `MEMBER#{sub}` row, an audit row read back after a retried put);
 *     PutItem only where the partition key matches the partitions a create writes and an entry audits
 *     ({@link WORKSPACE_WRITE_PARTITIONS}, `dynamodb:LeadingKeys`; a create is one TransactWriteItems, authorised
 *     per item as PutItem), every put conditional on a new key; UpdateItem only on `WS#*` and `WORKSPACES` (the
 *     `secret_status` of a new workspace's `META` and listing row). The audit-row guard (lib/utils/audit-row-guard.ts, which names this role the table's
 *     audit writer) denies it changing or removing an audit row. No DeleteItem, BatchWriteItem or Scan;
 *   - Cognito AdminListGroupsForUser + AdminGetUser on the user pool: the live platform-admin check
 *     (lambda/shared/platform_admin.py);
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
import type { ApiStackContext } from './api-context';

const WORKSPACES_API_FUNCTION_BASE_NAME = 'voc-workspaces-api';
const WORKSPACES_HANDLER_FILE = 'workspaces_handler.py';
/** The name prefix of every per-workspace credentials secret (`{prefix}/{ws}/credentials`). */
const WORKSPACE_SECRET_BASE_PREFIX = 'voc/ws';
/** Where the workspaces API puts (lambda/shared/platform_workspaces.py, workspace.py): a create's rows, the audits. */
const WORKSPACE_WRITE_PARTITIONS = ['AUDIT#WS#*', 'SLUG#*', 'USER#*', 'WORKSPACES', 'WS#*'];

/** Create, describe and tag the per-workspace credentials secrets, and no other secret. */
function grantWorkspaceSecrets(ctx: ApiStackContext, role: iam.Role, prefix: string): void {
  const { kmsKey } = ctx.props;
  const secretsArn = ctx.stack.formatArn({
    service: 'secretsmanager', resource: 'secret', resourceName: `${prefix}/*`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
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

export function createWorkspacesLambda(ctx: ApiStackContext): lambda.Function {
  const { workspacesTable, kmsKey, userPool } = ctx.props;
  const functionName = ctx.uniqueName(WORKSPACES_API_FUNCTION_BASE_NAME);
  const secretPrefix = ctx.prefixed(WORKSPACE_SECRET_BASE_PREFIX);
  const role = ctx.role('WorkspacesLambdaRole');
  workspacesTable.grant(role, 'dynamodb:Query', 'dynamodb:GetItem');
  grantKeyScopedWrites(workspacesTable, role, ['PutItem'], WORKSPACE_WRITE_PARTITIONS);
  // The new workspace's META and its listing row (their secret_status, shared/platform_workspaces.py mark_secret_ready).
  // `secret_status` only (and the key the update names): IAM, not just the code, keeps it off a member's role.
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], ['WORKSPACES', 'WS#*'], ['pk', 'secret_status', 'sk']);
  kmsKey.grantEncryptDecrypt(role);
  // The live platform-admin check (lambda/shared/platform_admin.py): the caller's groups and enabled state.
  userPool.grant(role, 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser');
  grantWorkspaceSecrets(ctx, role, secretPrefix);

  const environment: Record<string, string> = {
    WORKSPACES_TABLE: workspacesTable.tableName,
    USER_POOL_ID: userPool.userPoolId,
    KMS_KEY_ARN: kmsKey.keyArn,
    WORKSPACE_SECRET_PREFIX: secretPrefix,
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
    // voc-users-api's reads (lib/sizing/policy.ts); a create is one transaction and one CreateSecret.
    memorySize: 512,
    timeout: cdk.Duration.seconds(10),
    logGroup: ctx.logGroup('WorkspacesApiLogs', functionName),
  });
}
