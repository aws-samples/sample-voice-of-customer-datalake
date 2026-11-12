/**
 * @fileoverview The caller's workspaces (`GET /me/workspaces`), one cache entry shared by the workspace gate and
 * the header's workspace menu (rendered only under the gate), and the last workspace this browser entered, which
 * the picker highlights. The workspaces the server refused in this tab are in `refusedWorkspaces.ts`.
 *
 * @module workspace/useMyWorkspaces
 */
import { useQuery } from '@tanstack/react-query'
import { myWorkspacesKey, workspacesApi } from '../api/workspacesApi'

export function useMyWorkspaces() {
  return useQuery({ queryKey: myWorkspacesKey(), queryFn: workspacesApi.list })
}

/** localStorage: the slug of the workspace last entered in this browser (a highlight, never a redirect). */
const LAST_WORKSPACE_KEY = 'voc-last-workspace'

export function lastWorkspaceSlug(): string | null {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY)
  } catch {
    // Storage blocked: nothing is highlighted.
    return null
  }
}

export function rememberWorkspace(slug: string): void {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, slug)
  } catch {
    // Storage blocked: the picker simply highlights nothing next time.
  }
}
