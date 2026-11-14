/**
 * What the workspaces API's delete routes need (VocApiStack; lambda/api/workspaces_handler.py,
 * lambda/shared/workspace_deletes.py, docs/multi-workspace.md "Export and delete"): `POST /me/workspaces/current/delete`
 * asks for a workspace's hard delete, `POST /platform/workspaces/{ws}/delete/cancel` and `…/resume` cancel it in its
 * fence or resume it. The job, `voc-workspace-delete`, is VocProcessingStack's (workspace-delete-worker.ts), reached
 * here by name (Processing deploys first).
 *
 * The workspaces API's role gains, beside its own grants (api-workspaces-lambda.ts) and the export routes'
 * (api-workspace-export.ts, whose `WS#{one id}#JOB#export` writes take the export lock):
 *   - voc-aggregates: PutItem, UpdateItem and Query on `WS#{one id}#JOB#erasure` (the erasure lock: taken for the
 *     delete, its holder read, freed on a cancel);
 *   - voc-workspaces: UpdateItem of `status` and `deleting_at` only on `WS#{one id}` (META) and `WORKSPACES` (the listing
 *     row), conditional on the row naming the workspace; PutItem and UpdateItem on `WSDELETE` (the job row); PutItem on
 *     `AUDIT#workspace-deletes` (the platform's request, cancel and resume rows; the audit-row guard, which names this
 *     role voc-workspaces' audit writer, denies changing or removing one);
 *   - the job's invoke by name. No delete of anything: the job deletes.
 */
import type * as lambda from 'aws-cdk-lib/aws-lambda';

import { WORKSPACE_DELETE_FUNCTION_BASE_NAME } from '../utils/function-names';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { grantInvokeByName } from '../utils/worker-lambda';
import { WORKSPACE_HARD_DELETE_ENV, workspaceHardDeleteEnabled } from '../utils/workspace-hard-delete';
import type { ApiStackContext } from './api-context';
import { grantJobPartition } from './api-workspace-export';
import { WORKSPACE_ID_PATTERN } from './core-buckets';
import { DELETE_AUDIT_PARTITION, DELETE_JOB_PARTITION } from './workspace-delete-worker';

/** A workspace's erasure jobs and their lock in voc-aggregates (lambda/shared/erasure_jobs.py). */
export const ERASURE_JOB_PARTITION = `WS#${WORKSPACE_ID_PATTERN}#JOB#erasure`;
/** A workspace's own control partition, exactly `WS#{one id}` (its META; never a `WS#{id}#…` data partition). */
export const WORKSPACE_META_PARTITION = `WS#${WORKSPACE_ID_PATTERN}`;
/** What the request and the cancel change on META and the listing row (and the key and the condition they read). */
export const DELETE_STATUS_ATTRIBUTES = ['deleting_at', 'pk', 'sk', 'status', 'workspace_id'];

/** What a cancel alone writes (the flag off): the job row's move to `cancelled`, META and the listing row back to
 *  `active`, its platform audit row, and the erasure lock freed (the export lock is the export routes'). */
function grantCancelOnly(ctx: ApiStackContext, role: NonNullable<lambda.Function['role']>): void {
  const { aggregatesTable, workspacesTable } = ctx.props;
  grantKeyScopedWrites(aggregatesTable, role, ['UpdateItem'], [ERASURE_JOB_PARTITION]);
  for (const [writes, partitions, attributes] of [
    [['UpdateItem'], ['WORKSPACES', WORKSPACE_META_PARTITION], DELETE_STATUS_ATTRIBUTES],
    [['UpdateItem'], [DELETE_JOB_PARTITION], undefined],
    [['PutItem'], [DELETE_AUDIT_PARTITION], undefined],
  ] as const) grantKeyScopedWrites(workspacesTable, role, writes, partitions, attributes);
}

/** The delete routes' grants and where they find the job (env). With the flag off (lib/utils/workspace-hard-delete.ts)
 *  only the cancel's (a cancel only restores a workspace, so a delete waiting in its fence when the flag is turned off
 *  can still be cancelled), no invoke and no `DELETE_FUNCTION`, and `WORKSPACE_HARD_DELETE=false`: the request and
 *  the resume answer "not available in this deployment". */
export function grantWorkspaceDeleteRoutes(ctx: ApiStackContext, workspacesLambda: lambda.Function): void {
  const enabled = workspaceHardDeleteEnabled(ctx.stack);
  workspacesLambda.addEnvironment(WORKSPACE_HARD_DELETE_ENV, String(enabled));
  const role = workspacesLambda.role;
  if (role === undefined) throw new Error('the workspaces API has no role');
  if (!enabled) {
    grantCancelOnly(ctx, role);
    return;
  }
  const { aggregatesTable, workspacesTable } = ctx.props;
  // The erasure lock, as the export routes hold the export lock (one helper, api-workspace-export.ts).
  grantJobPartition(role, aggregatesTable, ERASURE_JOB_PARTITION, 'QueryWorkspaceErasureLock');
  // META and the listing row: their status only; the job row; the platform's delete audit rows.
  for (const [writes, partitions, attributes] of [
    [['UpdateItem'], ['WORKSPACES', WORKSPACE_META_PARTITION], DELETE_STATUS_ATTRIBUTES],
    [['PutItem', 'UpdateItem'], [DELETE_JOB_PARTITION], undefined],
    [['PutItem'], [DELETE_AUDIT_PARTITION], undefined],
  ] as const) grantKeyScopedWrites(workspacesTable, role, writes, partitions, attributes);
  const name = ctx.uniqueName(WORKSPACE_DELETE_FUNCTION_BASE_NAME);
  grantInvokeByName(ctx.stack, role, [name], 'StartWorkspaceDelete');
  workspacesLambda.addEnvironment('DELETE_FUNCTION', name);
}
