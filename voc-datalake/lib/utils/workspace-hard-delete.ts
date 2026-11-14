/**
 * `-c workspaceHardDelete=true` turns a workspace's hard delete on (docs/multi-workspace.md "Export and delete",
 * steps 3 and 4). Off by default, and kept off until the per-person export ships: a delete destroys members'
 * conversations and personal memories, of which they have no copy yet.
 *
 * Off: no `voc-workspace-delete` job and none of its grants (lib/stacks/workspace-delete-worker.ts is not built), only
 * the cancel's grants and no `DELETE_FUNCTION` on the workspaces API (lib/stacks/api-workspace-delete.ts), and
 * `WORKSPACE_HARD_DELETE=false` there, so the request and the resume answer 403 "not available in this deployment"
 * and write nothing (lambda/shared/workspace_deletes.py `require_hard_delete`); the cancel works whatever the flag (it
 * only restores a workspace). On: everything as built.
 */
import type { Construct } from 'constructs';

import { booleanContextFlag } from './context-flag';

const WORKSPACE_HARD_DELETE_CONTEXT = 'workspaceHardDelete';
/** The env var the workspaces API and the job read (`'true'` or `'false'`). */
export const WORKSPACE_HARD_DELETE_ENV = 'WORKSPACE_HARD_DELETE';

/** Whether this deployment builds and allows the hard delete (the module comment). */
export function workspaceHardDeleteEnabled(scope: Construct): boolean {
  return booleanContextFlag(scope.node.tryGetContext(WORKSPACE_HARD_DELETE_CONTEXT), WORKSPACE_HARD_DELETE_CONTEXT,
    false, 'Use -c workspaceHardDelete=true|false.');
}
