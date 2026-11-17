/**
 * @fileoverview Administration's addresses, as paths (7.49.00; the model is adminTabs.ts):
 *
 * - a tab: `/admin/<tab>` (`/admin` is General too), and on a tab with sections `/admin/<tab>/<section>`
 *   (`/admin/access/workspaces`);
 * - the Boards section's open editor: `/admin/access/boards/<boardId>`;
 * - the deployment's Data sources opened at one source's card: `/admin/data-sources/<source>` (7.50.02: the readiness
 *   fix and the setup guide open the GitHub Issues card at `/admin/data-sources/github_issues`), for a source the
 *   page shows (an unknown one is replaced by `/admin/data-sources`).
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

/** Where Administration is: its tab and section, on Boards the board whose editor is open, on Data sources the card. */
export interface AdminPlace extends AdminLocation {
  /** The board open in the Boards section's editor; null: the list. */
  readonly boardId: string | null
  /** The source whose card the deployment's Data sources opens (`/admin/data-sources/<source>`); null: none. */
  readonly sourceId: string | null
}

const GENERAL: AdminPlace = { tab: 'brand', section: null, boardId: null, sourceId: null }
const DATA_SOURCES = 'data-sources'

/** The path of a tab and section (`/admin/access/users`) and, on Boards, of one board's editor. */
export function adminPath(location: AdminLocation, boardId: string | null = null): string {
  const section = location.section === null ? [] : [location.section]
  const board = boardId !== null && boardId !== '' && location.section === 'boards' ? [boardId] : []
  return pathOf(['admin', location.tab, ...section, ...board])
}

/**
 * The deployment's Data sources opened at one source's card (7.50.02): `/admin/data-sources/<source>` (the GitHub
 * Issues card is `/admin/data-sources/github_issues`), the card opened and scrolled into view.
 */
export function deploymentSourcePath(source: string): string {
  return pathOf(['admin', DATA_SOURCES, source])
}

/** The source an Administration path opens on the deployment's Data sources (`/admin/data-sources/<source>`), or null. */
export function adminSourceOf(pathname: string): string | null {
  const [tab, source] = segmentsUnder(ADMIN_PATH, pathname) ?? []
  return tab === DATA_SOURCES && source !== undefined ? source : null
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
 * null outside Administration. `sources`: the ids of the sources the Data sources page shows (a card opened from the
 * path must be one of them).
 */
export function readAdminAddress(address: Address, isAdmin: boolean, isPlatformAdmin: boolean,
  sources: readonly string[] = []): PlaceRead<AdminPlace> | null {
  const segments = segmentsUnder(ADMIN_PATH, address.pathname)
  if (segments === null) return null
  if (segments.length === 0) return { place: GENERAL, replaceWith: null }
  const [tab = null, section = null] = segments
  const location = resolveAdminLocation(tab, section, isAdmin, isPlatformAdmin)
  const board = adminBoardOf(address.pathname)
  const source = adminSourceOf(address.pathname)
  const place: AdminPlace = {
    ...location, boardId: location.section === 'boards' ? board : null,
    sourceId: location.tab === DATA_SOURCES && source !== null && sources.includes(source) ? source : null,
  }
  const pathname = place.sourceId === null ? adminPath(location, place.boardId) : deploymentSourcePath(place.sourceId)
  return { place, replaceWith: pathname === address.pathname ? null : { pathname, search: address.search } }
}
