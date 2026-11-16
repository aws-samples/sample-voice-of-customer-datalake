/**
 * @fileoverview The Administration page's navigation model (5.09): six tabs
 * grouped by job, each with optional sections (`/admin/<tab>/<section>`, adminPaths.ts).
 *
 * An unknown tab or section falls back to what this caller may see, and the
 * page then replaces the address with the canonical path (adminPaths.ts).
 *
 * Visibility: an admin-only section is hidden from everyone else, and a tab
 * whose sections are all hidden is hidden too (non-admins keep General, Data
 * sources, Categories, AI models and Logs). Privacy & access → Workspaces,
 * the platform console (6.13), is shown to platform admins only.
 *
 * @module pages/Settings/adminTabs
 */

const ADMIN_TAB_IDS = ['brand', 'sources', 'taxonomy', 'access', 'ai', 'system'] as const
export type AdminTabId = typeof ADMIN_TAB_IDS[number]

const ADMIN_SECTION_IDS = [
  'plugins', 'integrations', 'inbox', 'radar',
  'categories', 'dimensions',
  'policies', 'users', 'boards', 'workspaces',
  'logs', 'version',
] as const
export type AdminSectionId = typeof ADMIN_SECTION_IDS[number]

interface SectionDef {
  readonly id: AdminSectionId
  readonly adminOnly: boolean
  /** Platform admins only (an administrator in `platform-admins`): the platform console. */
  readonly platformOnly?: boolean
}

interface TabDef {
  readonly id: AdminTabId
  /** Empty: the tab is one page (no section switch), open to every caller. */
  readonly sections: readonly SectionDef[]
}

const openTo = (id: AdminSectionId): SectionDef => ({ id, adminOnly: false })
const adminOnly = (id: AdminSectionId): SectionDef => ({ id, adminOnly: true })
const platformOnly = (id: AdminSectionId): SectionDef => ({ id, adminOnly: true, platformOnly: true })

const TABS: readonly TabDef[] = [
  { id: 'brand', sections: [] },
  { id: 'sources', sections: [openTo('plugins'), adminOnly('integrations'), adminOnly('inbox'), adminOnly('radar')] },
  { id: 'taxonomy', sections: [openTo('categories'), adminOnly('dimensions')] },
  { id: 'access', sections: [adminOnly('policies'), adminOnly('users'), adminOnly('boards'), platformOnly('workspaces')] },
  { id: 'ai', sections: [] },
  { id: 'system', sections: [openTo('logs'), adminOnly('version')] },
]

export interface AdminLocation {
  readonly tab: AdminTabId
  readonly section: AdminSectionId | null
}

function isAdminTabId(value: string): value is AdminTabId {
  return ADMIN_TAB_IDS.some((id) => id === value)
}

function tabDef(id: AdminTabId): TabDef {
  return TABS.find((tab) => tab.id === id) ?? { id, sections: [] }
}

function isVisible(section: SectionDef, isAdmin: boolean, isPlatformAdmin: boolean): boolean {
  if (section.platformOnly === true) return isAdmin && isPlatformAdmin
  return isAdmin || !section.adminOnly
}

/** The sections of `tab` this caller may see, in order. */
export function visibleSections(tab: AdminTabId, isAdmin: boolean, isPlatformAdmin: boolean): AdminSectionId[] {
  return tabDef(tab).sections.filter((section) => isVisible(section, isAdmin, isPlatformAdmin)).map((section) => section.id)
}

/** The tabs this caller may see: a tab with sections needs at least one visible section. */
export function visibleTabs(isAdmin: boolean, isPlatformAdmin: boolean): AdminTabId[] {
  return TABS
    .filter((tab) => tab.sections.length === 0 || visibleSections(tab.id, isAdmin, isPlatformAdmin).length > 0)
    .map((tab) => tab.id)
}

/**
 * A tab + a section, from the path → the location to show.
 * The `sources` tab is the Sources tab: with no section (or an unknown one) it
 * opens that tab's first visible section. The pre-5.09 `sources` id ("Sources
 * & privacy" → Source policies) is no longer aliased — the id is the new tab's
 * now, so an alias would be ambiguous.
 * Anything unknown or hidden from this caller falls back to its tab's first
 * visible section, or to General.
 */
export function resolveAdminLocation(
  tab: string | null, section: string | null, isAdmin: boolean, isPlatformAdmin: boolean,
): AdminLocation {
  const requested = requestedLocation(tab ?? '', section)
  const fallback: AdminLocation = { tab: 'brand', section: null }
  if (requested === null || !visibleTabs(isAdmin, isPlatformAdmin).includes(requested.tab)) return fallback
  const sections = visibleSections(requested.tab, isAdmin, isPlatformAdmin)
  const shown = sections.find((id) => id === requested.section) ?? sections[0] ?? null
  return { tab: requested.tab, section: shown }
}

function requestedLocation(tab: string, section: string | null): AdminLocation | null {
  if (!isAdminTabId(tab)) return null
  const sectionId = ADMIN_SECTION_IDS.find((id) => id === section) ?? null
  return { tab, section: sectionId }
}
