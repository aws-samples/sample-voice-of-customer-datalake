/**
 * `-c workspaceHardDelete=true` turns a workspace's hard delete on (docs/multi-workspace.md "Export and delete",
 * steps 3 and 4). Off by default.
 *
 * Owner decision (2026-11-15, 7.40.00): the hard delete no longer waits for a per-person export. A workspace admin's
 * confirmed delete removes the workspace and everything in it, its members' assistant conversations and personal
 * memories included, which the workspace's export does not hold: the web app says so before the admin confirms, and
 * offers the workspace's export first. It cannot be undone. Until 7.40.00 a synth with the flag failed
 * (`HARD_DELETE_REFUSED`, until the per-person export shipped); that refusal is lifted.
 *
 * Off: no `voc-workspace-delete` job and none of its grants (lib/stacks/workspace-delete-worker.ts is not built), only
 * the cancel's grants and no `DELETE_FUNCTION` on the workspaces API (lib/stacks/api-workspace-delete.ts), and
 * `WORKSPACE_HARD_DELETE=false` there, so the request and the resume answer 403 "not available in this deployment"
 * and write nothing (lambda/shared/workspace_deletes.py `require_hard_delete`); the cancel works whatever the flag (it
 * only restores a workspace). On: everything as the job needs.
 */
import type { Construct } from 'constructs';

import { booleanContextFlag } from './context-flag';

export const WORKSPACE_HARD_DELETE_CONTEXT = 'workspaceHardDelete';
/** The env var the workspaces API and the job read (`'true'` or `'false'`). */
export const WORKSPACE_HARD_DELETE_ENV = 'WORKSPACE_HARD_DELETE';

/** Whether this synth builds the hard delete (`-c workspaceHardDelete=true|false`, off by default). */
export function workspaceHardDeleteEnabled(scope: Construct): boolean {
  return booleanContextFlag(scope.node.tryGetContext(WORKSPACE_HARD_DELETE_CONTEXT), WORKSPACE_HARD_DELETE_CONTEXT,
    false, 'Use -c workspaceHardDelete=true|false.');
}
