/**
 * `-c workspaceHardDelete=true` would turn a workspace's hard delete on (docs/multi-workspace.md "Export and delete",
 * steps 3 and 4). It is REFUSED: a synth with it fails (`HARD_DELETE_REFUSED`) until members can export their own
 * conversations and personal memories, the gate docs/multi-workspace.md sets on the hard delete (TENETS.md D5: a
 * workspace's delete "offers an export first"; a delete destroys both, and the workspace's export holds neither). The
 * per-person export slice lifts the refusal. Nothing the app reads (context, cdk.json, a context file, `-c`, the
 * environment) can build the job until then.
 *
 * The repository's own tests and audits still build the job, to pin its code and its grants, through a code path the
 * app never takes: `HARD_DELETE_TEST_SWITCH`, set only by lib/test-support (its own app entry,
 * lib/test-support/hard-delete-app.ts, and synth-app.ts `withHardDeleteBuilt` around an in-process synth) and the
 * tests; bin/ never sets it (lib/stacks/workspace-delete-worker.test.ts holds both).
 *
 * Off (the default): no `voc-workspace-delete` job and none of its grants (lib/stacks/workspace-delete-worker.ts is
 * not built), only the cancel's grants and no `DELETE_FUNCTION` on the workspaces API
 * (lib/stacks/api-workspace-delete.ts), and `WORKSPACE_HARD_DELETE=false` there, so the request and the resume answer
 * 403 "not available in this deployment" and write nothing (lambda/shared/workspace_deletes.py `require_hard_delete`);
 * the cancel works whatever the flag (it only restores a workspace). Built: everything as the job needs.
 */
import type { Construct } from 'constructs';

import { booleanContextFlag } from './context-flag';

export const WORKSPACE_HARD_DELETE_CONTEXT = 'workspaceHardDelete';
/** The env var the workspaces API and the job read (`'true'` or `'false'`). */
export const WORKSPACE_HARD_DELETE_ENV = 'WORKSPACE_HARD_DELETE';
/** Why a synth with the flag fails. */
export const HARD_DELETE_REFUSED = 'workspaceHardDelete=true is refused: the hard delete stays off until members can '
  + 'export their own conversations and personal memories (docs/multi-workspace.md, "Export and delete", the gate on '
  + 'the hard delete; TENETS.md D5, a workspace\'s delete offers an export first)';

/** Whether the tests' own build of the refused job is under way in this process (the module comment): set only by
 *  lib/test-support (synth-app.ts `withHardDeleteBuilt`, hard-delete-app.ts) and the tests, never by bin/ or a stack. */
export const HARD_DELETE_TEST_SWITCH = { built: false };

/** Whether this synth builds the hard delete: never for the app (the module comment); throws `HARD_DELETE_REFUSED`
 *  when the flag is on outside the tests' own build. */
export function workspaceHardDeleteEnabled(scope: Construct): boolean {
  const on = booleanContextFlag(scope.node.tryGetContext(WORKSPACE_HARD_DELETE_CONTEXT), WORKSPACE_HARD_DELETE_CONTEXT,
    false, 'Use -c workspaceHardDelete=true|false.');
  if (on && !HARD_DELETE_TEST_SWITCH.built) throw new Error(HARD_DELETE_REFUSED);
  return on;
}
