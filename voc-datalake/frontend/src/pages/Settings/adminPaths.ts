/**
 * @fileoverview Administration's addresses (7.59.00; the model is adminTabs.ts). Where a person is, is the path
 * (utils/pathPlace.ts), the card a link names the hash:
 *
 * - a tab: `/admin/<tab>` (`/admin/general`, `/admin/ai`), and on a tab with sections one of them:
 *   `/admin/<tab>/<section>` (`/admin/access/users`, `/admin/sources/radar`); `/admin` opens General;
 * - the item open on a section: a person's editor `/admin/access/users/<username>` (the invite dialog:
 *   `/admin/access/users/invite`), a board's editor `/admin/access/boards/<boardId>`, one source's card
 *   `/admin/sources/plugins/<source>` for a source the page shows;
 * - a card: `#<card>` (`/admin/general#theme`, `/admin/access/policies#erasure`, `/admin/agents#models`).
 *
 * The query holds only Source settings' scope switch (`?scope=deployment`: the deployment's own sources, for platform
 * admins; `locationParams.test.ts`). The readiness fix and the setup guide open the deployment's GitHub Issues card at
 * `/admin/sources/plugins/github_issues?scope=deployment`.
 *
 * An address that does not name its place as it should is replaced by the place's own, in place, the rest of the query
 * kept: an unknown or hidden tab (General), a tab with sections without one or with an unknown one (its first), an
 * extra segment, a hash that names no card of the place (dropped). Two other spellings lead to the same places:
 * `/admin/<tab>#<section>` (a section named by the hash) and every address of 7.54.00 (`/admin/people/<username>`,
 * `/admin/brand/theme`, `/admin/privacy/erasure`, … {@link LEGACY}; those of 7.49.00–7.53.00 are this form already,
 * but for the console, `/admin/access/workspaces`); `/settings/…` is `/admin/…` (routes.tsx).
 *
 * @module pages/Settings/adminPaths
 */
import { pathOf, searchWithout, segmentsUnder } from '../../utils/pathPlace'
import type { Address, PlaceRead } from '../../utils/pathPlace'
import { isAdminCardId, isAdminSectionId, isAdminTabId, resolveAdminLocation, sectionOfCard } from './adminTabs'
import type { AdminCardId, AdminLocation, AdminSectionId, AdminTabId, AdminViewer } from './adminTabs'

export const ADMIN_PATH = '/admin'

/** Source settings' scope switch's query parameter, and its one value (absent: this workspace's sources). */
const SOURCE_SCOPE_PARAM = 'scope'
const DEPLOYMENT_SCOPE = 'deployment'

/** The Users item that opens the invite dialog rather than a person's editor (usernames are UUIDs, never this). */
export const PEOPLE_INVITE = 'invite'

/** Where Administration is: its tab, section and card, and the item open on the section (a person, a board, a source). */
export interface AdminPlace extends AdminLocation {
  /** Users: the person whose editor is open, or `invite`; Boards: the board whose editor is open; Source settings:
   * the source whose card is opened. Null: none. */
  readonly item: string | null
}

/** A place to link to: a tab, and optionally its section, the item open on it and a card. */
export interface AdminTarget {
  readonly tab: AdminTabId
  readonly section?: AdminSectionId | null
  readonly item?: string | null
  readonly card?: AdminCardId | null
}

/** The sections whose third segment names an item. */
const ITEM_SECTIONS: ReadonlySet<AdminSectionId> = new Set(['users', 'boards', 'plugins'])

/** The path of a place, without its card (`/admin/access/boards/brd_sales`). */
function placePath({ tab, section = null, item = null }: AdminTarget): string {
  if (section === null) return pathOf(['admin', tab])
  const opened = item !== null && item !== '' && ITEM_SECTIONS.has(section) ? [item] : []
  return pathOf(['admin', tab, section, ...opened])
}

/** The address of a place, its card as the hash (`/admin/general#theme`). */
export function adminPath(target: AdminTarget): string {
  const card = target.card ?? null
  return card === null ? placePath(target) : `${placePath(target)}#${card}`
}

/**
 * The deployment's own Source settings opened at one source's card
 * (`/admin/sources/plugins/github_issues?scope=deployment`): the card opened and scrolled into view, the
 * deployment's sources whatever workspace the app is in (platform admins).
 */
export function deploymentSourcePath(source: string): string {
  return `${adminPath({ tab: 'sources', section: 'plugins', item: source })}?${SOURCE_SCOPE_PARAM}=${DEPLOYMENT_SCOPE}`
}

/** The tab segment of an Administration path ('' for `/admin`), or null outside Administration. */
export function adminTabSegment(pathname: string): string | null {
  const segments = segmentsUnder(ADMIN_PATH, pathname)
  return segments === null ? null : segments[0] ?? ''
}

/** The item an Administration path opens on `section` of `tab` (`/admin/access/boards/<boardId>`), or null. */
export function adminItemOf(pathname: string, tab: AdminTabId, section: AdminSectionId): string | null {
  const [first, second, third] = segmentsUnder(ADMIN_PATH, pathname) ?? []
  return first === tab && second === section && third !== undefined && ITEM_SECTIONS.has(section) ? third : null
}

/** What an address asks for, before the viewer's rights and the model decide what is shown. */
interface Requested {
  readonly tab: string | null
  readonly section: string | null
  readonly item: string | null
  readonly card: string | null
}

const requested = (tab: string, section: string | null = null, item: string | null = null, card: string | null = null): Requested => ({
  tab, section, item, card,
})

/** Each 7.54.00 tab that is no tab now → where it lives (its second segment and the hash given). */
const LEGACY: Readonly<Record<string, (second: string | undefined, hash: string | null) => Requested>> = {
  people: (second) => requested('access', 'users', second ?? null),
  logs: () => requested('system', 'logs'),
  categories: (second) => requested('taxonomy', second === 'dimensions' ? 'dimensions' : 'categories'),
  boards: (second) => (second === 'domains' || second === 'participants'
    ? requested('access', 'boards', null, second)
    : requested('access', 'boards', second ?? null)),
  brand: (second, hash) => requested('general', null, null, second === 'theme' ? 'theme' : hash),
  privacy: (second, hash) => requested('access', 'policies', null, second === 'erasure' ? 'erasure' : hash),
  platform: (second) => requested('workspaces', second === 'deployment-brand' || second === 'costs' ? second : 'all'),
  version: () => requested('system', 'version'),
  // (7.50.00's deployment Data sources tab, for platform admins)
  'data-sources': (second) => requested('sources', 'plugins', second ?? null),
}

/** 7.49.00–7.53.00's Privacy & access → Workspaces (the platform console), now a tab of its own. */
const isOldConsole = (tab: string, second: string | undefined): boolean => tab === 'access' && second === 'workspaces'

/** Sources: a section of it, 7.54.00's Design-system tokens (`tokens`), or 7.54.00's one source's card (`/admin/sources/<source>`). */
function sourcesRequest(second: string | undefined, third: string | undefined, hash: string | null): Requested {
  if (second === undefined) return requested('sources', null, null, hash)
  if (second === 'tokens') return requested('sources', 'integrations')
  if (isAdminSectionId(second)) return requested('sources', second, third ?? null, hash)
  return requested('sources', 'plugins', second)
}

/** The section a hash names on a tab whose path names none: the section itself, or the section of the card it names. */
function sectionFromHash(tab: string, hash: string): { section: string | null; card: string | null } {
  if (isAdminSectionId(hash)) return { section: hash, card: null }
  if (isAdminCardId(hash) && isAdminTabId(tab)) return { section: sectionOfCard(tab, hash), card: hash }
  return { section: null, card: hash }
}

function requestOf(segments: readonly string[], hash: string | null): Requested {
  const [tab, second, third] = segments
  if (tab === undefined) return requested('', null, null, hash)
  const legacy = LEGACY[tab]
  if (legacy !== undefined) return legacy(second, hash)
  if (tab === 'sources' && second !== undefined) return sourcesRequest(second, third, hash)
  if (isOldConsole(tab, second)) return requested('workspaces', 'all')
  if (second === undefined && hash !== null) return { tab, item: null, ...sectionFromHash(tab, hash) }
  return requested(tab, second ?? null, third ?? null, hash)
}

/** The item a place may keep: any person or board, a source only when the page shows it. */
function itemOf(location: AdminLocation, item: string | null, sources: readonly string[]): string | null {
  if (item === null || location.section === null || !ITEM_SECTIONS.has(location.section)) return null
  if (location.section === 'plugins') return sources.includes(item) ? item : null
  return item
}

/** Whose sources an address shows: the deployment's (`?scope=deployment`) or, absent, this workspace's. */
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

/** The query a place keeps: the scope only on Source settings, for a viewer who may use it, and only its one value. */
function placeSearch(search: string, place: AdminPlace, mayUseDeployment: boolean): string {
  if (!new URLSearchParams(search).has(SOURCE_SCOPE_PARAM)) return search
  const kept = place.section === 'plugins' && mayUseDeployment && sourceScopeOf(search) === 'deployment'
  return kept ? search : searchWithout(search, [SOURCE_SCOPE_PARAM])
}

/** An address as the router's location has it: a pathname, its query and its hash (`#…` or ''). */
export interface AdminAddress extends Address {
  readonly hash: string
}

/**
 * The place an Administration address names for this viewer, and the address to replace it with (null: its own);
 * null outside Administration. `sources`: the ids of the sources Source settings shows (a card opened from the path
 * must be one of them).
 */
export function readAdminAddress(address: AdminAddress, viewer: AdminViewer,
  sources: readonly string[] = []): PlaceRead<AdminPlace> | null {
  const segments = segmentsUnder(ADMIN_PATH, address.pathname)
  if (segments === null) return null
  const hash = address.hash.replace(/^#/, '')
  const asked = requestOf(segments, hash === '' ? null : hash)
  const location = resolveAdminLocation(asked.tab, asked.section, asked.card, viewer)
  const place: AdminPlace = { ...location, item: itemOf(location, asked.item, sources) }
  const pathname = placePath(place)
  const search = placeSearch(address.search, place, viewer.isAdmin && viewer.isPlatformAdmin)
  const ownHash = place.card === null ? '' : `#${place.card}`
  const own = pathname === address.pathname && search === address.search && ownHash === address.hash
  return { place, replaceWith: own ? null : { pathname, search, hash: ownHash } }
}
