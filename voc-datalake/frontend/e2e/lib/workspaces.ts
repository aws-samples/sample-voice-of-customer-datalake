/**
 * Workspaces on a deployment (docs/multi-workspace.md; lambda/api/workspaces_handler.py): the slug a run's workspace
 * gets, the site's `features.workspaceDelete`, the platform list (paged) and the answers of the workspace routes, read
 * leniently. Used by tests/workspace-lifecycle.spec.ts and by the shared teardown (tests/cleanup.spec.ts), which
 * retires the workspaces and review pages a run recorded in its ledger.
 *
 * Every call that acts in a workspace sends its `X-Workspace-Id` (`apiCall`'s `workspace` option), as the SPA does
 * inside `/workspace/{slug}/`.
 */
import { apiCall, listOf, stringField } from './api'
import { siteUrl } from './env'
import { isRecord } from './guards'
import { e2eFetch } from './trafficTag'

/** platform_workspaces.py `_SLUG` and RESERVED_SLUGS (mock-workspaces.js holds the same). */
export const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const RESERVED_SLUGS: ReadonlySet<string> = new Set(['admin', 'api', 'app', 'platform', 'www'])

/** The reason a delete of an e2e workspace states (kept for good in the audit log: no personal data). */
export const E2E_DELETE_REASON = 'e2e cleanup'

/** The web_reviews plugin (plugins/web_reviews/manifest.json): review pages, each run in its workspace. */
export const WEB_REVIEWS = 'web_reviews'

/** shared/workspace_plugin_settings.py PLUGIN_NOT_ENABLED: a run of a plugin the workspace did not turn on (409). */
export const PLUGIN_NOT_ENABLED = 'Enable this plugin for the workspace first'

/** shared/workspace.py WORKSPACE_FAULT: the 500 a run answered before the 7.40.00 IAM fix (its plugin row unreadable). */
export const WORKSPACE_FAULT = 'Failed to open the workspace'

/**
 * The slug of run `runId`'s workspace: `e2e-<run id>` in lowercase, anything outside `[a-z0-9-]` turned into `-`, at
 * most 40 characters and not ending in `-`. Throws when that is still not a valid slug, rather than create one the
 * server refuses.
 */
export function slugFor(runId: string): string {
  const slug = `e2e-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40).replace(/-+$/, '')
  if (!WORKSPACE_SLUG.test(slug) || RESERVED_SLUGS.has(slug)) throw new Error(`no valid workspace slug for run id ${runId}`)
  return slug
}

/** A workspace as the workspace routes answer it (`{workspace: {id, name, slug, role?, …}}`, or a list row). */
export interface WorkspaceRow {
  id: string
  name: string
  slug: string
  role?: string
  status?: string
}

/** `raw` as a workspace (`{id, name, slug}` strings at least), or null. */
export function workspaceRow(raw: unknown): WorkspaceRow | null {
  if (!isRecord(raw)) return null
  const id = stringField(raw, 'id')
  const slug = stringField(raw, 'slug')
  const name = raw['name']
  if (id === undefined || slug === undefined || typeof name !== 'string') return null
  const role = stringField(raw, 'role')
  const status = stringField(raw, 'status')
  return { id, name, slug, ...(role === undefined ? {} : { role }), ...(status === undefined ? {} : { status }) }
}

/** The workspace of an answer `{workspace: {...}}` (`GET`/`PUT /me/workspaces/current`, `POST /platform/workspaces`). */
export function answeredWorkspace(body: unknown): WorkspaceRow | null {
  return isRecord(body) ? workspaceRow(body['workspace']) : null
}

/** The rows of a `{workspaces: [...]}` answer this suite can read. */
export function listedWorkspaces(body: unknown): WorkspaceRow[] {
  return listOf(body, 'workspaces').flatMap((row) => {
    const workspace = workspaceRow(row)
    return workspace === null ? [] : [workspace]
  })
}

/** How many pages of `GET /platform/workspaces` a lookup reads at most (100 rows each). */
const MAX_PLATFORM_PAGES = 50

/**
 * Workspace `id` as the platform list answers it (`{id, name, slug, status, …}`), paging through `next_cursor`, or
 * null when no page lists it (the delete job has removed it, or it never existed). Admin only (a platform admin).
 */
export async function platformWorkspace(id: string): Promise<WorkspaceRow | null> {
  let cursor: string | null = null
  for (let page = 0; page < MAX_PLATFORM_PAGES; page += 1) {
    const query: string = cursor === null ? 'limit=100' : `limit=100&cursor=${encodeURIComponent(cursor)}`
    const res = await apiCall('admin', 'GET', `/platform/workspaces?${query}`)
    if (res.status !== 200) throw new Error(`GET /platform/workspaces answered ${String(res.status)}`)
    const found = listedWorkspaces(res.body).find((row) => row.id === id)
    if (found !== undefined) return found
    const next: unknown = isRecord(res.body) ? res.body['next_cursor'] : null
    if (typeof next !== 'string' || next === '') return null
    cursor = next
  }
  return null
}

/** The site's `/config.json` `features` (a deployment's capability flags); `{}` when it cannot be read. */
export async function siteFeatures(): Promise<Record<string, unknown>> {
  const response = await e2eFetch(`${siteUrl()}/config.json`)
  if (!response.ok) return {}
  const body: unknown = await response.json().catch(() => null)
  const features = isRecord(body) ? body['features'] : undefined
  return isRecord(features) ? features : {}
}

/** Whether this deployment lets a workspace's admins delete it (`features.workspaceDelete`, `-c workspaceHardDelete=true`). */
export async function workspaceDeleteAvailable(): Promise<boolean> {
  return (await siteFeatures())['workspaceDelete'] === true
}

/** The plugins of a `GET /me/workspaces/current/plugins` answer: `{id, enabled}` each. */
export function workspacePlugins(body: unknown): Array<{ id: string; enabled: boolean }> {
  return listOf(body, 'plugins').flatMap((row) => {
    const id = stringField(row, 'id')
    return id === undefined ? [] : [{ id, enabled: row['enabled'] === true }]
  })
}

/** The `error` text of a refusal's body, or '' (a body without one). */
export function errorText(body: unknown): string {
  return isRecord(body) && typeof body['error'] === 'string' ? body['error'] : ''
}
