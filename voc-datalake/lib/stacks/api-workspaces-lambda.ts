/**
 * The workspaces API, `voc-workspaces-api` (VocApiStack, docs/multi-workspace.md; handler
 * lambda/api/workspaces_handler.py): GET /me/{proxy+}, the first routes of the multi-workspace control plane
 * (`/me/workspaces`, `/me/workspaces/current`).
 *
 * Built ON the stack (stable logical id `WorkspacesApi…`, like every api-*.ts builder). Its own role, on the
 * voc-workspaces table only (VocCoreStack):
 *   - Query: the caller's own `USER#{sub}` rows ("my workspaces");
 *   - GetItem: a workspace's `META` and the caller's `MEMBER#{sub}` row (shared/workspace.py);
 *   - PutItem, only where the partition key matches `AUDIT#WS#*` (`dynamodb:LeadingKeys`): the audit row of a
 *     platform admin's entry, a conditional put that never overwrites. It cannot put a `META`, `MEMBER#` or
 *     `USER#` row, and the audit-row guard (lib/utils/audit-row-guard.ts, which names this role the table's audit
 *     writer) denies it changing or removing an audit row.
 * No UpdateItem, DeleteItem, BatchWriteItem or Scan, and no other table.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { grantKeyScopedWrites } from '../utils/table-write-grants';
import type { ApiStackContext } from './api-context';

const WORKSPACES_API_FUNCTION_BASE_NAME = 'voc-workspaces-api';
const WORKSPACES_HANDLER_FILE = 'workspaces_handler.py';

export function createWorkspacesLambda(ctx: ApiStackContext): lambda.Function {
  const { workspacesTable, kmsKey } = ctx.props;
  const functionName = ctx.uniqueName(WORKSPACES_API_FUNCTION_BASE_NAME);
  const role = ctx.role('WorkspacesLambdaRole');
  workspacesTable.grant(role, 'dynamodb:Query', 'dynamodb:GetItem');
  // The entry audit rows' partitions only (shared/workspace.py: AUDIT#WS#{ws}).
  grantKeyScopedWrites(workspacesTable, role, ['PutItem'], ['AUDIT#WS#*']);
  kmsKey.grantEncryptDecrypt(role);

  const environment: Record<string, string> = {
    WORKSPACES_TABLE: workspacesTable.tableName,
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
    // The first call after sign-in: one Query or two GetItems, like voc-users-api's reads (lib/sizing/policy.ts).
    memorySize: 512,
    timeout: cdk.Duration.seconds(10),
    logGroup: ctx.logGroup('WorkspacesApiLogs', functionName),
  });
}
