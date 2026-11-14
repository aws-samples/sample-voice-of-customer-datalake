/**
 * What the workspaces API's export routes need (VocApiStack; lambda/api/workspaces_handler.py,
 * docs/multi-workspace.md "Export and delete"): `POST /me/workspaces/current/export` starts the job, `GET …/export`
 * reads its status, `POST …/export/link` signs a 15-minute download link. The job itself, `voc-workspace-export`,
 * is VocProcessingStack's (workspace-export-worker.ts), reached here by name (Processing deploys first).
 *
 * The workspaces API's role gains: PutItem, UpdateItem and Query on `WS#{one id}#JOB#export` in voc-aggregates (the
 * lock, the queued row, a failed start's outcome and release, the newest export), GetObject under
 * `ws/{one id}/exports/*` (it signs the download link), and the invoke of the job by name.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';

import { WORKSPACE_EXPORT_FUNCTION_BASE_NAME } from '../utils/function-names';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { grantInvokeByName } from '../utils/worker-lambda';
import type { ApiStackContext } from './api-context';
import { WORKSPACE_EXPORTS_PREFIX } from './core-buckets';
import { EXPORT_JOB_PARTITION } from './workspace-export-worker';

/** PutItem, UpdateItem and Query of one workspace's job partition in voc-aggregates (its lock and its job rows). */
export function grantJobPartition(role: iam.IRole, aggregatesTable: ApiStackContext['props']['aggregatesTable'],
  partition: string, sid: string): void {
  grantKeyScopedWrites(aggregatesTable, role, ['PutItem', 'UpdateItem'], [partition]);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid,
    actions: ['dynamodb:Query'],
    resources: [aggregatesTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [partition] } },
  }));
}

/** The export routes' grants and where they find the job (env). */
export function grantWorkspaceExportRoutes(ctx: ApiStackContext, workspacesLambda: lambda.Function): void {
  const { aggregatesTable, rawDataBucket } = ctx.props;
  const role = workspacesLambda.role;
  if (role === undefined) throw new Error('the workspaces API has no role');
  const exportFunctionName = ctx.uniqueName(WORKSPACE_EXPORT_FUNCTION_BASE_NAME);
  grantJobPartition(role, aggregatesTable, EXPORT_JOB_PARTITION, 'QueryWorkspaceExportJobs');
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'SignWorkspaceExportDownloads',
    actions: ['s3:GetObject'],
    resources: [rawDataBucket.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*`)],
  }));
  grantInvokeByName(ctx.stack, role, [exportFunctionName], 'StartWorkspaceExport');
  workspacesLambda.addEnvironment('AGGREGATES_TABLE', aggregatesTable.tableName);
  workspacesLambda.addEnvironment('RAW_DATA_BUCKET', rawDataBucket.bucketName);
  workspacesLambda.addEnvironment('EXPORT_FUNCTION', exportFunctionName);
}
