/**
 * @fileoverview The workspaces the server refused in this tab (sessionStorage): ids whose `/current` answered 404
 * though the list still names them (one being deleted, or a membership removed a moment ago:
 * lambda/shared/workspace.py). The gate leaves them out of the list for the rest of the tab, so the one-workspace
 * redirect cannot send the caller back into one, also after a full page load (which reads the list again). A new
 * tab asks the server again, and so does the next person after a sign-out or an expired session.
 *
 * No imports: the session-expiry service clears it without pulling in the API client.
 *
 * @module workspace/refusedWorkspaces
 */
const REFUSED_WORKSPACES_KEY = 'voc-refused-workspaces'

export function refusedWorkspaceIds(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(REFUSED_WORKSPACES_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    // Storage blocked or a value this build cannot read: nothing is left out.
    return []
  }
}

export function rememberRefused(id: string): void {
  const ids = refusedWorkspaceIds()
  if (ids.includes(id)) return
  try {
    window.sessionStorage.setItem(REFUSED_WORKSPACES_KEY, JSON.stringify([...ids, id]))
  } catch {
    // Storage blocked: the cached list still leaves it out until the next page load.
  }
}

/** Forget the tab's refused workspaces (sign-out, an expired session: the next person asks the server afresh). */
export function forgetRefused(): void {
  try {
    window.sessionStorage.removeItem(REFUSED_WORKSPACES_KEY)
  } catch {
    // Storage blocked: there is nothing stored to forget.
  }
}
