/**
 * @fileoverview Administration's addresses, as paths (7.49.00; the model is adminTabs.ts):
 *
 * - a tab: `/admin/<tab>` (`/admin` is General too), and on a tab with sections `/admin/<tab>/<section>`
 *   (`/admin/access/workspaces`);
 * - the Boards section's open editor: `/admin/access/boards/<boardId>`.
 *
 * A path that does not name its place as it should (a tab without its section, a section hidden from this caller,
 * an unknown id) is replaced by the place's own path, in place, the query kept. The query names no place: no
 * `?tab=&section=&board=` link of before is read (7.49.00, a pre-release change).
 *
 * @module pages/Settings/adminPaths
 */
import { pathOf, segmentsUnder } from '../../utils/pathPlace'
import type { Address, PlaceRead } from '../../utils/pathPlace'
import { resolveAdminLocation } from './adminTabs'
import type { AdminLocation } from './adminTabs'

export const ADMIN_PATH = '/admin'

/** Where Administration is: its tab and section, and on Boards the board whose editor is open. */
export interface AdminPlace extends AdminLocation {
  /** The board open in the Boards section's editor; null: the list. */
  readonly boardId: string | null
}

const GENERAL: AdminPlace = { tab: 'brand', section: null, boardId: null }

/** The path of a tab and section (`/admin/access/users`) and, on Boards, of one board's editor. */
export function adminPath(location: AdminLocation, boardId: string | null = null): string {
  const section = location.section === null ? [] : [location.section]
  const board = boardId !== null && boardId !== '' && location.section === 'boards' ? [boardId] : []
  return pathOf(['admin', location.tab, ...section, ...board])
}

/** The tab segment of an Administration path (`/admin` is General), or null outside Administration. */
export function adminTabSegment(pathname: string): string | null {
  const segments = segmentsUnder(ADMIN_PATH, pathname)
  return segments === null ? null : segments[0] ?? 'brand'
}

/** The board an Administration path opens in the Boards editor (`/admin/access/boards/<boardId>`), or null. */
export function adminBoardOf(pathname: string): string | null {
  const [tab, section, boardId] = segmentsUnder(ADMIN_PATH, pathname) ?? []
  return tab === 'access' && section === 'boards' && boardId !== undefined ? boardId : null
}

/**
 * The place an Administration address names for this caller, and the address to replace it with (null: its own);
 * null outside Administration.
 */
export function readAdminAddress(address: Address, isAdmin: boolean, isPlatformAdmin: boolean): PlaceRead<AdminPlace> | null {
  const segments = segmentsUnder(ADMIN_PATH, address.pathname)
  if (segments === null) return null
  if (segments.length === 0) return { place: GENERAL, replaceWith: null }
  const [tab = null, section = null] = segments
  const location = resolveAdminLocation(tab, section, isAdmin, isPlatformAdmin)
  const board = adminBoardOf(address.pathname)
  const place: AdminPlace = { ...location, boardId: location.section === 'boards' ? board : null }
  const pathname = adminPath(location, place.boardId)
  return { place, replaceWith: pathname === address.pathname ? null : { pathname, search: address.search } }
}
