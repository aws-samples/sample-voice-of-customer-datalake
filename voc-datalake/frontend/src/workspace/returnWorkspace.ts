/**
 * @fileoverview The workspace an external return goes back to (7.49.00): GitHub sends an administrator back from the
 * deployment's GitHub App to `/agents/connections/github/created` (the manifest's `redirect_url`) or `…/installed`
 * (its `setup_url`, fixed when the App is made, while an install can start in any workspace). Opened outside a
 * workspace, either page goes straight into the workspace the flow started in, its query carried through, and never
 * shows the workspace picker.
 *
 * The flow's workspace is remembered in this tab (sessionStorage, which a navigation to GitHub and back keeps) when
 * it starts: the manifest form posted, an install link opened. It is gone back to whether or not the caller's list
 * names it (a platform admin who entered from the console is no member): the gate decides again there, as for any
 * address (WorkspaceGate: the platform admin's direct entry, anyone else's not-found). Failing that (another tab, a
 * return from GitHub's own settings) the workspace last entered in this browser, else the caller's first.
 *
 * @module workspace/returnWorkspace
 */
import { z } from 'zod'
import { lastWorkspaceSlug } from './useMyWorkspaces'
import { isWorkspaceSlug } from './workspacePath'
import type { CurrentWorkspace } from './currentWorkspace'

/** The app paths an external service returns to (routes.tsx; lambda/engineering/connectors/github_apps.py). */
export const EXTERNAL_RETURN_PATHS: readonly string[] = ['/agents/connections/github/created', '/agents/connections/github/installed']

const FLOW_KEY = 'voc-github-app-flow'
/** How long a remembered flow counts: a state lives 30 minutes, the code an hour. */
const FLOW_MS = 60 * 60 * 1000

const flowSchema = z.object({ slug: z.string(), at: z.number() })

/** Remember, in this tab, that a GitHub App flow starts in the workspace `slug` (before the browser leaves for GitHub). */
export function rememberReturnWorkspace(slug: string, now: number = Date.now()): void {
  try {
    window.sessionStorage.setItem(FLOW_KEY, JSON.stringify({ slug, at: now }))
  } catch {
    // Storage blocked: the return falls back to the workspace last entered.
  }
}

function rememberedFlow(now: number): string | null {
  try {
    const raw = window.sessionStorage.getItem(FLOW_KEY)
    const flow = flowSchema.safeParse(raw === null ? null : JSON.parse(raw))
    return flow.success && now - flow.data.at <= FLOW_MS && isWorkspaceSlug(flow.data.slug) ? flow.data.slug : null
  } catch {
    return null
  }
}

/**
 * The workspace a return to `pathname` goes back to: the flow's (listed or not), else the last entered among the
 * caller's `workspaces`, else their first; null when `pathname` is no external return, or there is none to go to.
 */
export function returnWorkspace(pathname: string, workspaces: readonly CurrentWorkspace[], now: number = Date.now()): string | null {
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (!EXTERNAL_RETURN_PATHS.includes(path)) return null
  const listed = (slug: string | null) => (slug !== null && workspaces.some((workspace) => workspace.slug === slug) ? slug : null)
  return rememberedFlow(now) ?? listed(lastWorkspaceSlug()) ?? workspaces[0]?.slug ?? null
}
