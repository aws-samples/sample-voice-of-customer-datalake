/**
 * @fileoverview The Administration page's navigation model (7.59.00: main's tabbed layout again, docs/account-vs-admin.md):
 * one page, a row of tabs, and on a tab with several sections the section switch under it (SectionSwitch.tsx).
 *
 * The tabs, in main's order, then the two main never had (before System, which stays last):
 * **General · Sources · Taxonomy · Privacy & access · AI models · Workspaces · Engineering agents · System**.
 *
 * - A tab with sections shows one section at a time (`/admin/<tab>/<section>`, adminPaths.ts); a tab without is one page.
 * - A card a link may name (the default theme, the erasure panels, the company domains, …) is an anchor of its tab or
 *   section (`/admin/general#theme`, `/admin/access/policies#erasure`): the page scrolls to it and focuses it.
 *
 * Visibility ({@link AdminViewer}): an admin-only section is hidden from everyone else, and a tab whose sections are
 * all hidden is hidden too. Workspaces' This workspace and Members are shown inside a workspace, its All workspaces
 * and Deployment brand to platform admins; Engineering agents while the Agents page and the engineering module are
 * on. Anyone's link to a hidden or unknown place falls back to the tab's first section, or to General.
 *
 * @module pages/Settings/adminTabs
 */

const ADMIN_TAB_IDS = ['general', 'sources', 'taxonomy', 'access', 'ai', 'workspaces', 'agents', 'system'] as const
export type AdminTabId = typeof ADMIN_TAB_IDS[number]

/** The sections of the tabs that have a section switch (a path segment). */
const ADMIN_SECTION_IDS = [
  'plugins', 'integrations', 'inbox', 'radar',
  'categories', 'dimensions',
  'policies', 'users', 'boards',
  'settings', 'members', 'all', 'deployment-brand',
  'logs', 'version',
] as const
export type AdminSectionId = typeof ADMIN_SECTION_IDS[number]

/** The cards a link may name inside a tab or a section (the address's hash). */
const ADMIN_CARD_IDS = ['brand', 'theme', 'api', 'erasure', 'domains', 'participants', 'hard-cap', 'models', 'connections'] as const
export type AdminCardId = typeof ADMIN_CARD_IDS[number]

/** Who is looking: what decides which tabs and sections they see. */
export interface AdminViewer {
  /** In the deployment's `admins` group (`useIsAdmin`). */
  readonly isAdmin: boolean
  /** In `platform-admins` (`useIsPlatformAdmin`). */
  readonly isPlatformAdmin: boolean
  /** The app is inside a workspace (`useCurrentWorkspace() !== null`). */
  readonly inWorkspace: boolean
  /** The Agents page is in the menu and the engineering module is on. */
  readonly agentsShown: boolean
}

type Audience = 'open' | 'admins' | 'platform' | 'workspace' | 'agents'

interface SectionDef {
  readonly id: AdminSectionId
  readonly audience: Audience
  /** The cards of the section a link may name, in page order. */
  readonly cards: readonly AdminCardId[]
}

interface TabDef {
  readonly id: AdminTabId
  /** Who sees a tab without sections (one with sections is seen by whoever sees one of them). */
  readonly audience: Audience
  /** Empty: the tab is one page. */
  readonly sections: readonly SectionDef[]
  /** The cards of a one-page tab a link may name, in page order. */
  readonly cards: readonly AdminCardId[]
}

const section = (id: AdminSectionId, audience: Audience = 'open', cards: readonly AdminCardId[] = []): SectionDef => ({ id, audience, cards })
const onePage = (id: AdminTabId, audience: Audience, cards: readonly AdminCardId[] = []): TabDef => ({ id, audience, sections: [], cards })
const switched = (id: AdminTabId, sections: readonly SectionDef[]): TabDef => ({ id, audience: 'open', sections, cards: [] })

const TABS: readonly TabDef[] = [
  onePage('general', 'open', ['brand', 'theme', 'api']),
  switched('sources', [section('plugins'), section('integrations', 'admins'), section('inbox', 'admins'), section('radar', 'admins')]),
  switched('taxonomy', [section('categories'), section('dimensions', 'admins')]),
  switched('access', [section('policies', 'admins', ['erasure']), section('users', 'admins'), section('boards', 'admins', ['domains', 'participants'])]),
  onePage('ai', 'open'),
  switched('workspaces', [section('settings', 'workspace'), section('members', 'workspace'), section('all', 'platform'), section('deployment-brand', 'platform')]),
  onePage('agents', 'agents', ['hard-cap', 'models', 'connections']),
  switched('system', [section('logs'), section('version', 'admins')]),
]

/** Where Administration is: a tab, its section (null: a tab without sections) and the card a link names (null: none). */
export interface AdminLocation {
  readonly tab: AdminTabId
  readonly section: AdminSectionId | null
  readonly card: AdminCardId | null
}

/** The tab Administration opens on (`/admin`), and the one an unknown or hidden tab falls back to. */
export const ADMIN_FIRST_TAB: AdminTabId = 'general'

export function isAdminTabId(value: string): value is AdminTabId {
  return ADMIN_TAB_IDS.some((id) => id === value)
}

export function isAdminSectionId(value: string): value is AdminSectionId {
  return ADMIN_SECTION_IDS.some((id) => id === value)
}

export function isAdminCardId(value: string): value is AdminCardId {
  return ADMIN_CARD_IDS.some((id) => id === value)
}

function tabDef(id: AdminTabId): TabDef {
  return TABS.find((tab) => tab.id === id) ?? onePage(id, 'admins')
}

function admits(audience: Audience, viewer: AdminViewer): boolean {
  switch (audience) {
    case 'open': return true
    case 'admins': return viewer.isAdmin
    case 'platform': return viewer.isAdmin && viewer.isPlatformAdmin
    case 'workspace': return viewer.isAdmin && viewer.inWorkspace
    case 'agents': return viewer.isAdmin && viewer.agentsShown
  }
}

/** Whether `tab` has a section switch (its sections are path segments). */
export function hasSections(tab: AdminTabId): boolean {
  return tabDef(tab).sections.length > 0
}

/** The sections of `tab` this viewer may see, in order. */
export function visibleSections(tab: AdminTabId, viewer: AdminViewer): AdminSectionId[] {
  return tabDef(tab).sections.filter((def) => admits(def.audience, viewer)).map((def) => def.id)
}

/** Whether this viewer may see `tab`: one without sections by its audience, one with by a section left to see. */
function isVisibleTab(tab: AdminTabId, viewer: AdminViewer): boolean {
  const def = tabDef(tab)
  return def.sections.length === 0 ? admits(def.audience, viewer) : visibleSections(tab, viewer).length > 0
}

/** The tabs this viewer may see, in order. */
export function visibleTabs(viewer: AdminViewer): AdminTabId[] {
  return ADMIN_TAB_IDS.filter((tab) => isVisibleTab(tab, viewer))
}

/** The cards a link may name on `tab` (its own, or its `section`'s), in page order. */
export function cardsOf(tab: AdminTabId, sectionId: AdminSectionId | null): readonly AdminCardId[] {
  const def = tabDef(tab)
  if (sectionId === null) return def.cards
  return def.sections.find((candidate) => candidate.id === sectionId)?.cards ?? []
}

/** The section of `tab` whose card `card` is (`erasure` → `policies` on Privacy & access), or null. */
export function sectionOfCard(tab: AdminTabId, card: AdminCardId): AdminSectionId | null {
  return tabDef(tab).sections.find((candidate) => candidate.cards.includes(card))?.id ?? null
}

/**
 * A tab, a section and a card, as an address names them → the location to show this viewer: an unknown or hidden tab
 * is General; on a tab with sections an unknown or hidden section is its first visible one (on one without, none);
 * a card that is not on the location shown is dropped.
 */
export function resolveAdminLocation(tab: string | null, sectionId: string | null, card: string | null,
  viewer: AdminViewer): AdminLocation {
  const shownTab = tab !== null && isAdminTabId(tab) && isVisibleTab(tab, viewer) ? tab : ADMIN_FIRST_TAB
  const sections = visibleSections(shownTab, viewer)
  const shownSection = hasSections(shownTab) ? sections.find((id) => id === sectionId) ?? sections[0] ?? null : null
  const shownCard = cardsOf(shownTab, shownSection).find((id) => id === card) ?? null
  return { tab: shownTab, section: shownSection, card: shownCard }
}
