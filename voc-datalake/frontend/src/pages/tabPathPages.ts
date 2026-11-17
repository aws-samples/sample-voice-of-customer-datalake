/**
 * @fileoverview The pages whose tab (and section) is their path's second segment (7.49.00: `/admin/<tab>/…`,
 * `/account/briefing`, `/memory/personal`), read from each page's own path module so a page added there is added
 * here. The breadcrumbs end their trail at the page (components/Breadcrumbs/routeCrumbs.ts) and the assistant's page
 * context reads the tab from that segment (assistant/page/pageContext.ts).
 *
 * @module pages/tabPathPages
 */
import { ACCOUNT_PAGE } from './Account/accountSections'
import { COMPANY_PAGE } from './Company/companyPaths'
import { DATA_EXPLORER_PAGE } from './DataExplorer/dataExplorerPaths'
import { MEMORY_PAGE } from './Memory/memoryPaths'
import { PARTICIPANTS_PAGE } from './Participants/participantsPaths'
import { ADMIN_PATH } from './Settings/adminPaths'

/** Each such page's first path segment (`admin`, `account`, …). */
export const TAB_PATH_PAGES: ReadonlySet<string> = new Set(
  [ADMIN_PATH, ACCOUNT_PAGE.base, COMPANY_PAGE.base, MEMORY_PAGE.base, PARTICIPANTS_PAGE.base, DATA_EXPLORER_PAGE.base]
    .map((base) => base.slice(1)),
)
