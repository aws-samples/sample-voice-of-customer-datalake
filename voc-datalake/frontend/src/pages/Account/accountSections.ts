/**
 * @fileoverview The Account page's tabs and their deep links
 * (`/account?tab=<id>`), the same top tab bar as Company, Memory and the
 * project pages. Five tabs, each grouping the cards that belong together:
 * Profile (details, password, sign out) · Preferences (language, theme, Home
 * setup, assistant, this browser) · Morning brief · Objectives · Access &
 * tokens (my access, MCP tokens). docs/account-vs-admin.md is the placement rule.
 *
 * Every older link still lands: the 5.09–5.11 `?section=<id>` ids (ten rail
 * sections) map to the tab holding that card and are replaced by the
 * canonical `?tab=` form; an unknown or missing id opens Profile.
 * @module pages/Account/accountSections
 */

export const ACCOUNT_TAB_IDS = ['profile', 'preferences', 'briefing', 'objectives', 'access'] as const

export type AccountTabId = typeof ACCOUNT_TAB_IDS[number]

const DEFAULT_TAB: AccountTabId = 'profile'

/**
 * The 5.09–5.11 rail section ids → the tab that now holds that card. A Map, not
 * an object: `?section=` is user input, and `constructor` must not resolve.
 */
const LEGACY_SECTION_TABS: ReadonlyMap<string, AccountTabId> = new Map([
  ['profile', 'profile'], ['password', 'profile'], ['signout', 'profile'],
  ['preferences', 'preferences'], ['assistant', 'preferences'], ['browser', 'preferences'],
  ['briefing', 'briefing'],
  ['objectives', 'objectives'],
  ['access', 'access'], ['mcp', 'access'],
])

function isAccountTabId(value: string | null): value is AccountTabId {
  return ACCOUNT_TAB_IDS.some((id) => id === value)
}

/** The link to one Account tab. */
export function accountTabPath(tab: AccountTabId): string {
  return `/account?tab=${tab}`
}

/** The tab `?tab=` (or a pre-5.12 `?section=`) opens. */
export function resolveAccountTab(tab: string | null, section: string | null): AccountTabId {
  if (isAccountTabId(tab)) return tab
  return (section === null ? undefined : LEGACY_SECTION_TABS.get(section)) ?? DEFAULT_TAB
}

/** `?tab=<id>` when the query is not already the canonical form of where it leads, else null. */
export function accountRedirect(tab: string | null, section: string | null): string | null {
  if (tab === null && section === null) return null
  const resolved = resolveAccountTab(tab, section)
  return tab === resolved && section === null ? null : `?tab=${resolved}`
}
