/**
 * @fileoverview Administration's addresses, as paths (7.54.00; the model is adminTabs.ts):
 *
 * - the home: `/admin`;
 * - a tab: `/admin/<tab>` (`/admin/people`), and one card of its page: `/admin/<tab>/<section>`
 *   (`/admin/categories/dimensions`, `/admin/sources/radar`);
 * - the item open on a tab: a board's editor `/admin/boards/<boardId>`, a person's editor `/admin/people/<username>`
 *   (the invite dialog: `/admin/people/invite`), one source's card `/admin/sources/<source>` for a source the page
 *   shows (an unknown one is replaced by `/admin/sources`).
 *
 * The query holds only the Data sources scope switch (`?scope=deployment`: the deployment's own sources, for platform
 * admins; `locationParams.test.ts`), a filter that combines with every Data sources address. The readiness fix and the
 * setup guide open the deployment's GitHub Issues card at `/admin/sources/github_issues?scope=deployment`.
 *
 * A path that does not name its place as it should (an unknown tab or section, one hidden from this caller, an extra
 * segment) is replaced by the place's own path, in place, the rest of the query kept; a scope this caller may not
 * use, or on another tab, is dropped. No address of before 7.54.00 is aliased (`/admin/access/users`,
 * `/admin/data-sources`, `/admin/taxonomy/categories`, …): an unknown tab opens the home.
 *
 * @module pages/Settings/adminPaths
 */
import { pathOf, searchWithout, segmentsUnder } from '../../utils/pathPlace'
import type { Address, PlaceRead } from '../../utils/pathPlace'
import { ADMIN_HOME, isAdminTabId, isVisibleSection, resolveAdminLocation } from './adminTabs'
import type { AdminLocation, AdminTabId } from './adminTabs'

export const ADMIN_PATH = '/admin'

/** The Data sources scope switch's query parameter, and its one value (absent: this workspace's sources). */
const SOURCE_SCOPE_PARAM = 'scope'
const DEPLOYMENT_SCOPE = 'deployment'

/** The People item that opens the invite dialog rather than a person's editor (usernames are UUIDs, never this). */
export const PEOPLE_INVITE = 'invite'

/** Where Administration is: its tab and card, and the item open on the tab (a board, a person, a source's card). */
export interface AdminPlace extends AdminLocation {
  /** Boards: the board whose editor is open; People: the person whose editor is open, or `invite`; Data sources: the
   * source whose card is opened. Null: none. */
  readonly item: string | null
}

const HOME: AdminPlace = { ...ADMIN_HOME, item: null }

/** The tabs whose second segment may name an item rather than a section. */
const ITEM_TABS: ReadonlySet<AdminTabId> = new Set(['boards', 'people', 'sources'])

/** The path of a place: the home, a tab, a tab's card, or the item open on a tab (`/admin/boards/brd_sales`). */
export function adminPath(location: AdminLocation, item: string | null = null): string {
  if (location.tab === null) return ADMIN_PATH
  if (location.section !== null) return pathOf(['admin', location.tab, location.section])
  const opened = item !== null && item !== '' && ITEM_TABS.has(location.tab) ? [item] : []
  return pathOf(['admin', location.tab, ...opened])
}

/** One tab's path (`/admin/people`). */
export const adminTabPath = (tab: AdminTabId): string => adminPath({ tab, section: null })

/**
 * The deployment's own Data sources opened at one source's card (`/admin/sources/github_issues?scope=deployment`): the
 * card opened and scrolled into view, the deployment's sources whatever workspace the app is in (platform admins).
 */
export function deploymentSourcePath(source: string): string {
  return `${adminPath({ tab: 'sources', section: null }, source)}?${SOURCE_SCOPE_PARAM}=${DEPLOYMENT_SCOPE}`
}

/** The tab segment of an Administration path ('' for the home `/admin`), or null outside Administration. */
export function adminTabSegment(pathname: string): string | null {
  const segments = segmentsUnder(ADMIN_PATH, pathname)
  return segments === null ? null : segments[0] ?? ''
}

/** The item an Administration path opens on `tab` (`/admin/boards/<boardId>` on boards), or null. */
export function adminItemOf(pathname: string, tab: AdminTabId): string | null {
  const [first, second] = segmentsUnder(ADMIN_PATH, pathname) ?? []
  if (first !== tab || second === undefined || !ITEM_TABS.has(tab)) return null
  // A section's card is no item (on Data sources: `/admin/sources/radar` is the Radar card, not a source).
  return isVisibleSection(tab, second, true, true) ? null : second
}

/** The item a place may keep: any board or person, a source only when the page shows it. */
function itemOf(location: AdminLocation, segment: string | undefined, sources: readonly string[]): string | null {
  if (location.tab === null || location.section !== null || segment === undefined || !ITEM_TABS.has(location.tab)) return null
  if (location.tab === 'sources') return sources.includes(segment) ? segment : null
  return segment
}

/** Whose sources a Data sources address shows: the deployment's (`?scope=deployment`) or, absent, this workspace's. */
export type SourceScope = 'workspace' | 'deployment'

/** The scope an address's query names (the page's address is already canonical: a scope it may not use is gone). */
export function sourceScopeOf(search: string): SourceScope {
  return new URLSearchParams(search).get(SOURCE_SCOPE_PARAM) === DEPLOYMENT_SCOPE ? 'deployment' : 'workspace'
}

/** `search` switched to `scope`, every other parameter kept. */
export function withSourceScope(search: string, scope: SourceScope): string {
  const rest = searchWithout(search, [SOURCE_SCOPE_PARAM])
  if (scope === 'workspace') return rest
  const joiner = rest === '' ? '?' : '&'
  return `${rest}${joiner}${SOURCE_SCOPE_PARAM}=${DEPLOYMENT_SCOPE}`
}

/** The query a place keeps: the scope only on Data sources, for a caller who may use it, and only its one value. */
function placeSearch(search: string, place: AdminPlace, mayUseDeployment: boolean): string {
  if (!new URLSearchParams(search).has(SOURCE_SCOPE_PARAM)) return search
  const kept = place.tab === 'sources' && mayUseDeployment && sourceScopeOf(search) === 'deployment'
  return kept ? search : searchWithout(search, [SOURCE_SCOPE_PARAM])
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
  const [tab = null, second] = segments
  const location = resolveAdminLocation(tab !== null && isAdminTabId(tab) ? tab : null, second ?? null, isAdmin, isPlatformAdmin)
  const place: AdminPlace = location.tab === null ? HOME : { ...location, item: itemOf(location, second, sources) }
  const pathname = adminPath(place, place.item)
  const search = placeSearch(address.search, place, isAdmin && isPlatformAdmin)
  const own = pathname === address.pathname && search === address.search
  return { place, replaceWith: own ? null : { pathname, search } }
}
