/**
 * @fileoverview The Administration page's navigation model (7.54.00): a home (`/admin`) and nine tabs, ordered by the
 * job an administrator comes to do and how often (docs/account-vs-admin.md), in four groups the home and the left
 * navigation share:
 *
 * - Everyday: People · Data sources · Logs
 * - Regularly: Categories · Feedback boards
 * - Set up once: AI models · Brand & appearance
 * - Rare: Privacy · Platform (platform admins only)
 *
 * Version and the release notes are a tab outside the groups, opened from the home's footer.
 *
 * A tab is ONE page; its sections are cards on it (`/admin/<tab>/<section>` opens the page with that card scrolled
 * into view and focused, adminPaths.ts), never a second row of navigation. An unknown tab falls back to the home, an
 * unknown or hidden section to its tab, and the page then replaces the address with the canonical path.
 *
 * Visibility: an admin-only tab or section is hidden from everyone else (non-admins keep Data sources, Logs,
 * Categories, AI models and Brand & appearance, read-only where the server says so); Platform is shown to platform
 * admins only (an administrator in `platform-admins`). Anyone else's link to a hidden place falls back like an
 * unknown id.
 *
 * @module pages/Settings/adminTabs
 */

const ADMIN_TAB_IDS = ['people', 'sources', 'logs', 'categories', 'boards', 'ai', 'brand', 'privacy', 'platform', 'version'] as const
export type AdminTabId = typeof ADMIN_TAB_IDS[number]

/** The cards a path may name, per tab below. */
export type AdminSectionId =
  | 'inbox' | 'radar' | 'tokens'
  | 'dimensions'
  | 'domains' | 'participants'
  | 'theme'
  | 'erasure'
  | 'deployment-brand'

/** Who may see a tab or a section: everyone with Administration, administrators, or platform admins. */
type Audience = 'open' | 'admins' | 'platform'

interface SectionDef {
  readonly id: AdminSectionId
  readonly audience: Audience
}

interface TabDef {
  readonly id: AdminTabId
  readonly audience: Audience
  /** The cards of the page a path may name, in page order. */
  readonly sections: readonly SectionDef[]
}

const section = (id: AdminSectionId, audience: Audience = 'open'): SectionDef => ({ id, audience })

const TABS: readonly TabDef[] = [
  { id: 'people', audience: 'admins', sections: [] },
  // Email inbox, Radar and the design-system tokens sit in the page's Advanced fold.
  { id: 'sources', audience: 'open', sections: [section('inbox', 'admins'), section('radar', 'admins'), section('tokens', 'admins')] },
  { id: 'logs', audience: 'open', sections: [] },
  { id: 'categories', audience: 'open', sections: [section('dimensions', 'admins')] },
  { id: 'boards', audience: 'admins', sections: [section('domains'), section('participants')] },
  { id: 'ai', audience: 'open', sections: [] },
  { id: 'brand', audience: 'open', sections: [section('theme')] },
  { id: 'privacy', audience: 'admins', sections: [section('erasure')] },
  { id: 'platform', audience: 'platform', sections: [section('deployment-brand')] },
  { id: 'version', audience: 'admins', sections: [] },
]

/** The navigation's groups, in order; the home lists the same groups. Version is in none (the home's footer). */
export const ADMIN_GROUPS = [
  { id: 'everyday', tabs: ['people', 'sources', 'logs'] },
  { id: 'regular', tabs: ['categories', 'boards'] },
  { id: 'once', tabs: ['ai', 'brand'] },
  { id: 'rare', tabs: ['privacy', 'platform'] },
] as const satisfies ReadonlyArray<{ readonly id: string; readonly tabs: readonly AdminTabId[] }>

export type AdminGroupId = typeof ADMIN_GROUPS[number]['id']

/** Where Administration is: a tab (null: the home) and the card of it a path names (null: none). */
export interface AdminLocation {
  readonly tab: AdminTabId | null
  readonly section: AdminSectionId | null
}

export const ADMIN_HOME: AdminLocation = { tab: null, section: null }

export function isAdminTabId(value: string): value is AdminTabId {
  return ADMIN_TAB_IDS.some((id) => id === value)
}

function tabDef(id: AdminTabId): TabDef {
  return TABS.find((tab) => tab.id === id) ?? { id, audience: 'admins', sections: [] }
}

function admits(audience: Audience, isAdmin: boolean, isPlatformAdmin: boolean): boolean {
  if (audience === 'platform') return isAdmin && isPlatformAdmin
  return audience === 'open' || isAdmin
}

/** Whether this caller may see `tab`. */
export function isVisibleTab(tab: AdminTabId, isAdmin: boolean, isPlatformAdmin: boolean): boolean {
  return admits(tabDef(tab).audience, isAdmin, isPlatformAdmin)
}

/** The sections (cards a path may name) of `tab` this caller may see, in page order: none on a tab they may not see. */
export function visibleSections(tab: AdminTabId, isAdmin: boolean, isPlatformAdmin: boolean): AdminSectionId[] {
  if (!isVisibleTab(tab, isAdmin, isPlatformAdmin)) return []
  return tabDef(tab).sections.filter((def) => admits(def.audience, isAdmin, isPlatformAdmin)).map((def) => def.id)
}

/** The groups and their tabs this caller may see, a group with none left out. */
export function visibleGroups(isAdmin: boolean, isPlatformAdmin: boolean): { id: AdminGroupId; tabs: AdminTabId[] }[] {
  return ADMIN_GROUPS
    .map((group) => ({ id: group.id, tabs: group.tabs.filter((tab) => isVisibleTab(tab, isAdmin, isPlatformAdmin)) }))
    .filter((group) => group.tabs.length > 0)
}

/** Whether `value` names a section of `tab` this caller may see. */
export function isVisibleSection(tab: AdminTabId, value: string, isAdmin: boolean, isPlatformAdmin: boolean): value is AdminSectionId {
  return visibleSections(tab, isAdmin, isPlatformAdmin).some((id) => id === value)
}

/**
 * A tab + a section, from the path → the location to show: a tab unknown or hidden from this caller is the home; a
 * section unknown or hidden from this caller is no section (its tab). The tab ids of before 7.54.00 (`access`,
 * `taxonomy`, `system`, `data-sources`, `brand`'s General) are not aliased: the ones that are no tab now open the home.
 */
export function resolveAdminLocation(
  tab: string | null, sectionId: string | null, isAdmin: boolean, isPlatformAdmin: boolean,
): AdminLocation {
  if (tab === null || !isAdminTabId(tab) || !isVisibleTab(tab, isAdmin, isPlatformAdmin)) return ADMIN_HOME
  const shown = sectionId !== null && isVisibleSection(tab, sectionId, isAdmin, isPlatformAdmin) ? sectionId : null
  return { tab, section: shown }
}
