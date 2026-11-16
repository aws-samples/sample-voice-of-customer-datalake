/**
 * @fileoverview A platform admin's direct link into a workspace they are not a member of (7.49.00): `/workspace/<slug>/…`
 * pasted or shared, rather than the platform console's Enter. Since every place in the app is a path, every shared
 * link is such a direct link.
 *
 * It takes the console's own entry (platformEntry.ts), never a bypass: the workspace's id is read from the console's
 * list (`GET /platform/workspaces`, platform admins only, live-checked by the server), recorded as Enter records it,
 * and the gate then asks `GET /me/workspaces/current` with it, which lets a live-checked platform admin in as admin
 * and audits the entry (lambda/shared/workspace.py). Anyone else gets the same not-found as for any slug that is not
 * theirs: the list is not even asked for a caller whose token names no platform admin, and the server refuses it
 * anyway (its 403 is that not-found too). Any other failure of the lookup (a fault, a throttle) is the gate's
 * "could not load" page with Try again, never a not-found for a workspace that may exist.
 *
 * @module workspace/platformDirectEntry
 */
import { useQuery } from '@tanstack/react-query'
import { apiErrorStatus, HTTP_FORBIDDEN } from '../api/apiErrorStatus'
import { platformWorkspacesApi } from '../api/platformWorkspacesApi'
import { useIsPlatformAdmin } from '../store/authStore'
import { platformEntryFor, rememberPlatformEntry } from './platformEntry'
import { PAGE_WORKSPACE } from './workspacePath'
import type { CurrentWorkspace } from './currentWorkspace'
import type { PlatformEntry } from './platformEntry'

/** A page of the console's list for the lookup: the server's largest. */
const LOOKUP_PAGE = 100
/** The most pages of the console's list read for one slug (4,000 workspaces). */
const MAX_PAGES = 40

/** The deployment's workspace with `slug`, read from the console's list a page at a time, or null. */
async function platformWorkspaceBySlug(slug: string, cursor: string | null = null, page = 1): Promise<PlatformEntry | null> {
  const { rows, nextCursor } = await platformWorkspacesApi.list(cursor, LOOKUP_PAGE)
  const found = rows.find((row) => row.slug === slug)
  if (found !== undefined) return { id: found.id, slug: found.slug }
  return nextCursor === null || page >= MAX_PAGES ? null : platformWorkspaceBySlug(slug, nextCursor, page + 1)
}

export type DirectEntry =
  /** Nothing to look up: not a `/workspace/` address, a listed workspace, an entry already recorded, or not a platform admin. */
  | { readonly kind: 'none' }
  | { readonly kind: 'looking' }
  /** Found (and recorded as the console's Enter records it), or not (a 403 too): the plain not-found. */
  | { readonly kind: 'done'; readonly entry: PlatformEntry | null }
  /** The lookup failed otherwise: the gate's "could not load" page, `retry` asking again. */
  | { readonly kind: 'failed'; readonly retry: () => void; readonly retrying: boolean }

/**
 * For a platform admin on `/workspace/<slug>/…` of a workspace outside their list `workspaces` (null: not read yet) with no
 * entry recorded in this tab, the console's entry for it, looked up and recorded.
 */
export function usePlatformDirectEntry(workspaces: readonly CurrentWorkspace[] | null): DirectEntry {
  const isPlatformAdmin = useIsPlatformAdmin()
  const slug = PAGE_WORKSPACE.kind === 'slug' ? PAGE_WORKSPACE.slug : null
  const wanted = slug !== null && isPlatformAdmin && workspaces !== null
    && !workspaces.some((workspace) => workspace.slug === slug) && platformEntryFor(slug) === null
  const lookup = useQuery({
    queryKey: ['platform-direct-entry', slug ?? ''],
    queryFn: async () => {
      const entry = slug === null ? null : await platformWorkspaceBySlug(slug)
      if (entry !== null) rememberPlatformEntry(entry)
      return entry
    },
    enabled: wanted,
    retry: false,
    staleTime: Infinity,
  })
  if (!wanted) return { kind: 'none' }
  if (lookup.isPending) return { kind: 'looking' }
  if (lookup.isError && apiErrorStatus(lookup.error) !== HTTP_FORBIDDEN) {
    return { kind: 'failed', retry: () => { void lookup.refetch() }, retrying: lookup.isFetching }
  }
  return { kind: 'done', entry: lookup.data ?? null }
}
