/**
 * @fileoverview Which Administration place is open: the tab, its section, the card the hash names, the item open on
 * the section (a person's or a board's editor, a source's card) and Source settings' scope. The address is the source
 * of truth (adminPaths.ts; {@link readAdminAddress}).
 *
 * - Choosing a tab, a section, an item or a scope PUSHES its address, so Back returns to the previous place and a
 *   copied link opens where the user was.
 * - An address that is not the canonical form of where it leads (`/admin`, a tab without its section, an address of
 *   7.54.00, a section named by the hash) is replaced by that form in place (no history entry), the query (the review
 *   modal's `?review=`) kept.
 * - A section's drafts live on it, so its editors' unsaved-changes guards ask before the section is left (a path
 *   change); General's brand and theme drafts ask before General is left ({@link leavesAdminTab}); a card's hash and an
 *   overlay such as `?review=` are no leave.
 *
 * @module pages/Settings/useAdminLocation
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import { usePlaceNavigate, useReplaceAddress } from '../../utils/pathPlace'
import { noCleanup } from '../../hooks/noCleanup'
import { getEnabledPlugins } from '../../plugins'
import { isMenuItemEnabled } from '../../config/menuConfig'
import { isEngineeringAvailable } from '../../runtimeConfig'
import { useIsAdmin, useIsPlatformAdmin } from '../../store/authStore'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { adminItemOf, adminPath, adminTabSegment, readAdminAddress, sourceScopeOf, withSourceScope } from './adminPaths'
import type { AdminPlace, SourceScope } from './adminPaths'
import type { AdminCardId, AdminSectionId, AdminTabId, AdminViewer } from './adminTabs'
import { ADMIN_FIRST_TAB, hasSections, visibleSections } from './adminTabs'
import { cardAnchorId } from './adminTabLabels'

/** The guard's `shouldBlock` for General's drafts: only a move to another tab (or out of Administration) loses them. */
export const leavesAdminTab = (current: Location, next: Location): boolean =>
  adminTabSegment(current.pathname) !== adminTabSegment(next.pathname)

/** How long a hash's card may take to appear before it is no longer waited for. */
const CARD_WAIT_MS = 10_000

const FIRST_PLACE: AdminPlace = { tab: ADMIN_FIRST_TAB, section: null, card: null, item: null }

/** Who is looking (adminTabs.ts): the groups they are in, whether the app is in a workspace, whether Agents is on. */
export function useAdminViewer(): AdminViewer {
  const isAdmin = useIsAdmin()
  const isPlatformAdmin = useIsPlatformAdmin()
  const inWorkspace = useCurrentWorkspace() !== null
  return { isAdmin, isPlatformAdmin, inWorkspace, agentsShown: isMenuItemEnabled('agents') && isEngineeringAvailable() }
}

export function useAdminLocation(viewer: AdminViewer) {
  const address = useLocation()
  // (a card opened from the path is one Source settings shows: its plugins, SettingsSections.tsx)
  const read = readAdminAddress(address, viewer, getEnabledPlugins().map((plugin) => plugin.id))
  useReplaceAddress(read?.replaceWith ?? null)
  const move = usePlaceNavigate()
  const search = read?.replaceWith?.search ?? address.search
  const place = read?.place ?? FIRST_PLACE
  /** Open a tab (a tab with sections: its first this viewer sees); the scope goes with Source settings only. */
  const selectTab = (tab: AdminTabId) => {
    const section = hasSections(tab) ? visibleSections(tab, viewer)[0] ?? null : null
    move({ pathname: adminPath({ tab, section }), search })
  }
  /** Open a section of the open tab. */
  const selectSection = (section: AdminSectionId) => { move({ pathname: adminPath({ tab: place.tab, section }), search }) }
  return { place, selectTab, selectSection }
}

/** The item open on `section` of `tab` (`/admin/<tab>/<section>/<item>`) and the move that opens one (null: none). */
function useItemInPath(tab: AdminTabId, section: AdminSectionId): readonly [string | null, (item: string | null) => void] {
  const address = useLocation()
  const move = usePlaceNavigate()
  const open = (item: string | null) => { move({ pathname: adminPath({ tab, section, item }), search: address.search }) }
  return [adminItemOf(address.pathname, tab, section), open]
}

/** Boards' open editor (`/admin/access/boards/<boardId>`) and the move that opens one (null: the list). */
export function useBoardInPath(): readonly [string | null, (boardId: string | null) => void] {
  return useItemInPath('access', 'boards')
}

/** Users' open editor (`/admin/access/users/<username>`) or invite dialog (`/admin/access/users/invite`). */
export function usePersonInPath(): readonly [string | null, (item: string | null) => void] {
  return useItemInPath('access', 'users')
}

/**
 * The source whose card Source settings opens (`/admin/sources/plugins/<source>`: the readiness fix and the setup
 * guide open the GitHub Issues card), or null. The page's address is already its canonical form
 * ({@link useAdminLocation}: a source the page does not show is replaced), so the segment is read as it is.
 */
export function useSourceInPath(): string | null {
  return adminItemOf(useLocation().pathname, 'sources', 'plugins')
}

/** Source settings' scope (`?scope=deployment`, a platform admin's) and the switch (a history entry of its own). */
export function useSourceScope(): readonly [SourceScope, (scope: SourceScope) => void] {
  const address = useLocation()
  const move = usePlaceNavigate()
  const select = (scope: SourceScope) => { move({ pathname: address.pathname, search: withSourceScope(address.search, scope) }) }
  return [sourceScopeOf(address.search), select]
}

/**
 * Focus the card the hash names (CardAnchor.tsx), each time it names another one: focusing it scrolls it into view,
 * and a keyboard or screen reader user lands on it rather than at the top of the page. A card that renders once its
 * data arrives (the erasure panels) is focused when it appears, within ten seconds.
 */
export function useCardFocus(card: AdminCardId | null): void {
  useEffect(() => {
    if (card === null) return noCleanup
    const id = cardAnchorId(card)
    const focus = (): boolean => {
      const target = document.getElementById(id)
      target?.focus()
      return target !== null
    }
    if (focus()) return noCleanup
    const observer = new MutationObserver(() => { if (focus()) observer.disconnect() })
    observer.observe(document.body, { childList: true, subtree: true })
    const timer = window.setTimeout(() => observer.disconnect(), CARD_WAIT_MS)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [card])
}
