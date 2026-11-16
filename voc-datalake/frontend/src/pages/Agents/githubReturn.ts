/**
 * @fileoverview Before the browser leaves for GitHub (the manifest form posted, an install link opened; 7.49.00): the
 * workspace the flow starts in is remembered in this tab, so GitHub's return to a top-level page goes straight back
 * into it (workspace/returnWorkspace.ts), never through the workspace picker.
 *
 * @module pages/Agents/githubReturn
 */
import { rememberReturnWorkspace } from '../../workspace/returnWorkspace'
import { PAGE_WORKSPACE } from '../../workspace/workspacePath'

/** Remember this page's workspace for GitHub's return (nothing outside a workspace). */
export function leavingForGitHub(): void {
  if (PAGE_WORKSPACE.kind === 'slug') rememberReturnWorkspace(PAGE_WORKSPACE.slug)
}
