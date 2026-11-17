/**
 * @fileoverview The Account page's tabs and their paths (`/account/<id>`,
 * utils/tabPaths.ts), the same top tab bar as Company, Memory and the
 * project pages. Five tabs, each grouping the cards that belong together:
 * Profile (details, password, sign out) · Preferences (language, theme, Home
 * setup, assistant, this browser) · Morning brief · Objectives · Access &
 * tokens (my access, MCP tokens). docs/account-vs-admin.md is the placement rule.
 *
 * `/account` opens Preferences (7.54.00), the tab people come for most (theme, language): it is first here, the
 * landing; the tab bar keeps its own order (AccountNav.tsx). An unknown tab opens Preferences too, its path
 * replacing the address. No query link of before (`?tab=`, `?section=`) is read (7.49.00, a pre-release change).
 * @module pages/Account/accountSections
 */
import { tabPath } from '../../utils/tabPaths'
import type { TabPage } from '../../utils/tabPaths'

/** The first is the landing (`/account`): Preferences. */
export const ACCOUNT_TAB_IDS = ['preferences', 'profile', 'briefing', 'objectives', 'access'] as const

export type AccountTabId = typeof ACCOUNT_TAB_IDS[number]

/** The Account page's tabs as paths. */
export const ACCOUNT_PAGE: TabPage<AccountTabId> = { base: '/account', tabs: ACCOUNT_TAB_IDS }

/** The link to one Account tab. */
export function accountTabPath(tab: AccountTabId): string {
  return tabPath(ACCOUNT_PAGE, tab)
}
