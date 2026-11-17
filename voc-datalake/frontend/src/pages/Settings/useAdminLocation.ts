/**
 * @fileoverview Which Administration place is open: the home or a tab, the card a path names, the item open on the
 * tab (a board's or a person's editor, a source's card) and the Data sources scope. The path is the source of truth
 * (adminPaths.ts; {@link resolveAdminLocation}).
 *
 * - Opening a tab, an item or a scope PUSHES its address, so Back returns to the previous place and a copied link
 *   opens where the user was.
 * - An address that is not the canonical form of where it leads (an unknown tab, a section hidden from this caller)
 *   is replaced by that form in place (no history entry), the query (the review modal's `?review=`) kept.
 * - Each tab's drafts live on its page, so an editor's unsaved-changes guard asks before its tab is left
 *   ({@link leavesAdminTab}); an overlay such as `?review=` is no leave.
 *
 * @module pages/Settings/useAdminLocation
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import { usePlaceNavigate, useReplaceAddress } from '../../utils/pathPlace'
import { noCleanup } from '../../hooks/noCleanup'
import { getEnabledPlugins } from '../../plugins'
import { adminItemOf, adminPath, adminTabSegment, readAdminAddress, sourceScopeOf, withSourceScope } from './adminPaths'
import type { AdminPlace, SourceScope } from './adminPaths'
import type { AdminSectionId, AdminTabId } from './adminTabs'
import { sectionAnchorId } from './adminTabLabels'

/** The guard's `shouldBlock` for an editor on one tab: only a move to another tab (or out of Administration) loses it. */
export const leavesAdminTab = (current: Location, next: Location): boolean =>
  adminTabSegment(current.pathname) !== adminTabSegment(next.pathname)

/** How long a path's card may take to appear before it is no longer waited for. */
const SECTION_WAIT_MS = 10_000

const HOME_PLACE: AdminPlace = { tab: null, section: null, item: null }

export function useAdminLocation(isAdmin: boolean, isPlatformAdmin: boolean) {
  const address = useLocation()
  // (a card opened from the path is one the Data sources page shows: its plugins, SettingsSections.tsx)
  const read = readAdminAddress(address, isAdmin, isPlatformAdmin, getEnabledPlugins().map((plugin) => plugin.id))
  useReplaceAddress(read?.replaceWith ?? null)
  const move = usePlaceNavigate()
  const search = read?.replaceWith?.search ?? address.search
  const place = read?.place ?? HOME_PLACE
  /** Open a tab (null: the home); the scope switch's query goes with Data sources only (adminPaths.ts drops it). */
  const selectTab = (tab: AdminTabId | null) => { move({ pathname: adminPath({ tab, section: null }), search }) }
  return { place, selectTab }
}

/** The item open on `tab` (`/admin/<tab>/<item>`) and the move that opens one (null: none), the query kept. */
function useItemInPath(tab: AdminTabId): readonly [string | null, (item: string | null) => void] {
  const address = useLocation()
  const move = usePlaceNavigate()
  const open = (item: string | null) => { move({ pathname: adminPath({ tab, section: null }, item), search: address.search }) }
  return [adminItemOf(address.pathname, tab), open]
}

/** The Boards page's open editor (`/admin/boards/<boardId>`) and the move that opens one (null: the list). */
export function useBoardInPath(): readonly [string | null, (boardId: string | null) => void] {
  return useItemInPath('boards')
}

/** The People page's open editor (`/admin/people/<username>`) or invite dialog (`/admin/people/invite`). */
export function usePersonInPath(): readonly [string | null, (item: string | null) => void] {
  return useItemInPath('people')
}

/**
 * The source whose card Data sources opens (`/admin/sources/<source>`: the readiness fix and the setup guide open the
 * GitHub Issues card), or null. The page's address is already its canonical form ({@link useAdminLocation}: a source
 * the page does not show is replaced), so the segment is read as it is.
 */
export function useSourceInPath(): string | null {
  return adminItemOf(useLocation().pathname, 'sources')
}

/** Data sources' scope (`?scope=deployment`, a platform admin's) and the switch (a history entry of its own). */
export function useSourceScope(): readonly [SourceScope, (scope: SourceScope) => void] {
  const address = useLocation()
  const move = usePlaceNavigate()
  const select = (scope: SourceScope) => { move({ pathname: address.pathname, search: withSourceScope(address.search, scope) }) }
  return [sourceScopeOf(address.search), select]
}

/**
 * Focus the card `section` names (SectionAnchor.tsx), each time the path names another one: focusing it scrolls it
 * into view, and a keyboard or screen reader user lands on it rather than at the top of the page. A card that renders
 * once its data arrives (the erasure panels) is focused when it appears, within ten seconds.
 */
export function useSectionFocus(section: AdminSectionId | null): void {
  useEffect(() => {
    if (section === null) return noCleanup
    const id = sectionAnchorId(section)
    const focus = (): boolean => {
      const target = document.getElementById(id)
      target?.focus()
      return target !== null
    }
    if (focus()) return noCleanup
    const observer = new MutationObserver(() => { if (focus()) observer.disconnect() })
    observer.observe(document.body, { childList: true, subtree: true })
    const timer = window.setTimeout(() => observer.disconnect(), SECTION_WAIT_MS)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [section])
}
