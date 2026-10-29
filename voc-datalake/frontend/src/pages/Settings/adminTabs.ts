/**
 * @fileoverview The Administration page's navigation model (5.09): six tabs
 * grouped by job, each with optional sections (`?tab=<tab>&section=<section>`).
 *
 * Every pre-5.09 tab id still deep-links: {@link resolveAdminLocation} maps it
 * to its new tab and section, and the page then replaces the URL with the
 * canonical form ({@link canonicalSearch}).
 *
 * Visibility: an admin-only section is hidden from everyone else, and a tab
 * whose sections are all hidden is hidden too (non-admins keep General, Data
 * sources, Categories, AI models and Logs).
 *
 * @module pages/Settings/adminTabs
 */

const ADMIN_TAB_IDS = ['brand', 'sources', 'taxonomy', 'access', 'ai', 'system'] as const
export type AdminTabId = typeof ADMIN_TAB_IDS[number]

const ADMIN_SECTION_IDS = [
  'plugins', 'integrations', 'inbox', 'radar',
  'categories', 'dimensions',
  'policies', 'users', 'boards',
  'logs', 'version',
] as const
export type AdminSectionId = typeof ADMIN_SECTION_IDS[number]

interface SectionDef {
  readonly id: AdminSectionId
  readonly adminOnly: boolean
}

interface TabDef {
  readonly id: AdminTabId
  /** Empty: the tab is one page (no section switch), open to every caller. */
  readonly sections: readonly SectionDef[]
}

const openTo = (id: AdminSectionId): SectionDef => ({ id, adminOnly: false })
const adminOnly = (id: AdminSectionId): SectionDef => ({ id, adminOnly: true })

const TABS: readonly TabDef[] = [
  { id: 'brand', sections: [] },
  { id: 'sources', sections: [openTo('plugins'), adminOnly('integrations'), adminOnly('inbox'), adminOnly('radar')] },
  { id: 'taxonomy', sections: [openTo('categories'), adminOnly('dimensions')] },
  { id: 'access', sections: [adminOnly('policies'), adminOnly('users'), adminOnly('boards')] },
  { id: 'ai', sections: [] },
  { id: 'system', sections: [openTo('logs'), adminOnly('version')] },
]

export interface AdminLocation {
  readonly tab: AdminTabId
  readonly section: AdminSectionId | null
}

/** Every pre-5.09 `?tab=` id → where it lives now. `brand` and `ai` kept their ids. */
const LEGACY_TAB_LOCATIONS: Readonly<Record<string, AdminLocation>> = {
  plugins: { tab: 'sources', section: 'plugins' },
  integrations: { tab: 'sources', section: 'integrations' },
  radar: { tab: 'sources', section: 'radar' },
  categories: { tab: 'taxonomy', section: 'categories' },
  dimensions: { tab: 'taxonomy', section: 'dimensions' },
  users: { tab: 'access', section: 'users' },
  logs: { tab: 'system', section: 'logs' },
  version: { tab: 'system', section: 'version' },
}

function isAdminTabId(value: string): value is AdminTabId {
  return ADMIN_TAB_IDS.some((id) => id === value)
}

function tabDef(id: AdminTabId): TabDef {
  return TABS.find((tab) => tab.id === id) ?? { id, sections: [] }
}

/** The sections of `tab` this caller may see, in order. */
export function visibleSections(tab: AdminTabId, isAdmin: boolean): AdminSectionId[] {
  return tabDef(tab).sections.filter((section) => isAdmin || !section.adminOnly).map((section) => section.id)
}

/** The tabs this caller may see: a tab with sections needs at least one visible section. */
export function visibleTabs(isAdmin: boolean): AdminTabId[] {
  return TABS
    .filter((tab) => tab.sections.length === 0 || visibleSections(tab.id, isAdmin).length > 0)
    .map((tab) => tab.id)
}

/**
 * `?tab=` (new or pre-5.09 id) + `&section=` → the location to show.
 * `?tab=sources` is the Sources tab: with no section (or an unknown one) it
 * opens that tab's first visible section. The pre-5.09 `sources` id ("Sources
 * & privacy" → Source policies) is no longer aliased — the id is the new tab's
 * now, so an alias would be ambiguous.
 * Anything unknown or hidden from this caller falls back to its tab's first
 * visible section, or to General.
 */
export function resolveAdminLocation(tab: string | null, section: string | null, isAdmin: boolean): AdminLocation {
  const requested = requestedLocation(tab ?? '', section)
  const fallback: AdminLocation = { tab: 'brand', section: null }
  if (requested === null || !visibleTabs(isAdmin).includes(requested.tab)) return fallback
  const sections = visibleSections(requested.tab, isAdmin)
  const shown = sections.find((id) => id === requested.section) ?? sections[0] ?? null
  return { tab: requested.tab, section: shown }
}

function requestedLocation(tab: string, section: string | null): AdminLocation | null {
  const legacy = LEGACY_TAB_LOCATIONS[tab]
  if (legacy !== undefined) return legacy
  if (!isAdminTabId(tab)) return null
  const sectionId = ADMIN_SECTION_IDS.find((id) => id === section) ?? null
  return { tab, section: sectionId }
}

/** The canonical query for a location: `tab=<tab>` plus `&section=<section>` when the tab has one. */
export function canonicalSearch(location: AdminLocation): string {
  const params = new URLSearchParams({ tab: location.tab })
  if (location.section !== null) params.set('section', location.section)
  return params.toString()
}
