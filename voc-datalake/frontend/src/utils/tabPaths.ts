/**
 * @fileoverview A page whose only place is its tab, as a path (7.49.00, utils/pathPlace.ts): `/<page>/<tab>`, the
 * page's own path being its first tab too (`/memory` is `/memory/company`). Account, Company, Memory, Participants,
 * the Data Explorer and an agent's page are such pages; each names its tabs once ({@link TabPage}), and reads and
 * moves with {@link useTabPath}.
 *
 * - A tab switch PUSHES the tab's path, so Back and Forward walk the tabs and a copied link opens the tab; every
 *   query parameter stays (an open review modal's `?review=`).
 * - A path naming no tab of the page is replaced by its first tab's path in place (no history entry). The query names
 *   no tab: no `?tab=` link of before is read (a pre-release change).
 *
 * @module utils/tabPaths
 */
import { useLocation } from 'react-router-dom'
import { pathOf, segmentsUnder, usePlaceNavigate, useReplaceAddress } from './pathPlace'
import type { Address, PlaceRead } from './pathPlace'

export interface TabPage<T extends string> {
  /** The page's path (`/memory`). */
  readonly base: string
  /** Its tabs; the first is the one its own path opens. */
  readonly tabs: readonly [T, ...T[]]
}

/** The path of one tab (`/memory/personal`). */
export function tabPath<T extends string>(page: Pick<TabPage<T>, 'base'>, tab: T): string {
  return `${page.base}${pathOf([tab])}`
}

/**
 * The tab an address of `page` names, and the address to replace it with (null: the tab's own); null when the
 * address is not the page's.
 */
export function readTabAddress<T extends string>(page: TabPage<T>, address: Address): PlaceRead<T> | null {
  const segments = segmentsUnder(page.base, address.pathname)
  if (segments === null) return null
  const [segment] = segments
  const tab = page.tabs.find((candidate) => candidate === segment) ?? page.tabs[0]
  const own = segment === undefined || (segments.length === 1 && segment === tab)
  return { place: tab, replaceWith: own ? null : { pathname: tabPath(page, tab), search: address.search } }
}

/** The open tab of `page` (from its path) and the switch to another (a history entry); see the module's doc. */
export function useTabPath<T extends string>(page: TabPage<T>): readonly [T, (tab: T) => void] {
  const address = useLocation()
  const read = readTabAddress(page, address)
  useReplaceAddress(read?.replaceWith ?? null)
  const move = usePlaceNavigate()
  const select = (tab: T) => { move({ pathname: tabPath(page, tab), search: address.search }) }
  return [read?.place ?? page.tabs[0], select]
}
