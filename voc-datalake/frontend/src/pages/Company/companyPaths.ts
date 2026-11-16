/**
 * @fileoverview Knowledge → Company's tabs as paths (7.49.00, utils/tabPaths.ts): `/company/vision` (`/company` too),
 * `/company/design`, `/company/personas`. The caller's own objectives are Account's (`/account/objectives`).
 *
 * @module pages/Company/companyPaths
 */
import { tabPath } from '../../utils/tabPaths'
import type { TabPage } from '../../utils/tabPaths'

export const COMPANY_TABS = ['vision', 'design', 'personas'] as const
export type CompanyTab = typeof COMPANY_TABS[number]

export const COMPANY_PAGE: TabPage<CompanyTab> = { base: '/company', tabs: COMPANY_TABS }

/** The link to one Company tab. */
export function companyTabPath(tab: CompanyTab): string {
  return tabPath(COMPANY_PAGE, tab)
}
