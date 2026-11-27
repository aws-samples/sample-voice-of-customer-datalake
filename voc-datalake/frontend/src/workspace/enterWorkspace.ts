/**
 * @fileoverview A platform admin's way into a workspace: a full page load to `/workspace/{slug}/…`, with the workspace
 * recorded for the gate first (`platformEntry.ts`), so it opens once the server answers it even when the caller's own
 * list does not name it (a workspace they are not a member of, or one just made that the list does not show yet).
 * The platform console's Enter and the gate's Create a workspace (WorkspaceChoice.tsx) both go this way.
 *
 * @module workspace/enterWorkspace
 */
import { rememberPlatformEntry } from './platformEntry'
import type { PlatformEntry } from './platformEntry'
import { workspaceUrl } from './workspacePath'

/** Enter `workspace` (at `path`, its Home by default) with a full page load, the gate told which workspace the address
 *  names. */
export function enterWorkspace(workspace: PlatformEntry, path = '/'): void {
  rememberPlatformEntry(workspace)
  window.location.assign(workspaceUrl(workspace.slug, path))
}
