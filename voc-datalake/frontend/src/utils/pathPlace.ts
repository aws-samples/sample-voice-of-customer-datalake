/**
 * @fileoverview What the app's addresses share (7.49.00, docs/document-canvas.md → "Addresses"): where a person is
 * (a page, its tab and section, the item open on it, a sub-view or a mode) is the PATH; only filters, search and the
 * like, which combine freely, stay in the query.
 *
 * Each area names its own places in a small module (pages/ProjectDetail/projectPaths.ts, pages/Settings/adminPaths.ts,
 * pages/Agents/agentsPaths.ts, …): how a place is written as a path, and how a path is read back. This module holds
 * the parts they share: the segments under a page's path, a query without some of its parameters, and the two hooks
 * every area uses (a move to a place, and the in-place replacement of a path that does not name its place as it
 * should: an unknown tab, a tab without its section). No query link of before is read (a pre-release change).
 *
 * @module utils/pathPlace
 */
import { useCallback, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/** A pathname and its query (`?…` or ''), as the router's location has them; a hash (`#…` or '') when it says where too. */
export interface Address {
  readonly pathname: string
  readonly search: string
  /** (7.59.00) Absent: the address keeps whatever hash it has (Administration's cards are its hash: adminPaths.ts). */
  readonly hash?: string
}

/** What an area reads in an address: its place, and the address to replace it with (null: the place's own). */
export interface PlaceRead<P> {
  readonly place: P
  readonly replaceWith: Address | null
}

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * The segments of `pathname` under `base`, decoded (`/admin/access/users/u-1` under `/admin` → `['access', 'users', 'u-1']`,
 * `/admin` → `[]`), or null when `pathname` is not `base` or under it (`/administration`).
 */
export function segmentsUnder(base: string, pathname: string): string[] | null {
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null
  return pathname.slice(base.length).split('/').filter((segment) => segment !== '').map(decodedSegment)
}

/** A path from its segments, each encoded (`['agents', 'ag 1']` → `/agents/ag%201`). */
export function pathOf(segments: readonly string[]): string {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`
}

/** `search` without the parameters `names`, every other one kept in its order: `?…`, or '' when none is left. */
export function searchWithout(search: string, names: readonly string[]): string {
  const params = new URLSearchParams(search)
  names.forEach((name) => { params.delete(name) })
  const rest = params.toString()
  return rest === '' ? '' : `?${rest}`
}

/**
 * Replace the current address by `to` in place (no history entry, so Back never returns to the old form), keeping
 * the hash unless `to` names its own; null: nothing to replace. An effect, not a layout effect: the router takes a navigation only once its
 * own effect has run. Meanwhile the page reads its place as the replacement will name it.
 */
export function useReplaceAddress(to: Address | null): void {
  const { hash } = useLocation()
  const navigate = useNavigate()
  const target = to === null ? null : `${to.pathname}${to.search}${to.hash ?? hash}`
  useEffect(() => {
    if (target !== null) void navigate(target, { replace: true })
  }, [navigate, target])
}

/**
 * A move to a place: a history entry of its own (so Back and Forward walk tabs, sections and the items opened on
 * them), or in place with `replace`. Moving to the address already shown adds nothing (re-clicking the open tab).
 */
export function usePlaceNavigate(): (to: Address, options?: { readonly replace?: boolean }) => void {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  return useCallback((to: Address, options: { readonly replace?: boolean } = {}) => {
    if (to.pathname === pathname && to.search === search) return
    void navigate({ pathname: to.pathname, search: to.search }, { replace: options.replace === true })
  }, [navigate, pathname, search])
}
