/**
 * @fileoverview Which Administration tab, section and board editor is open: the path is the source of truth
 * (`/admin/<tab>/<section>[/<boardId>]`, adminPaths.ts; {@link resolveAdminLocation}).
 *
 * - A tab or section switch, and opening or closing a board's editor, PUSHES its path, so Back returns to the
 *   previous place and a copied link opens where the user was.
 * - A path that is not the canonical form of where it leads (a tab without its section, a section hidden from this
 *   caller) is replaced by that form in place (no history entry), the query (the review modal's `?review=`) kept.
 * - The brand draft lives at page level, so the page's unsaved-changes guard blocks only leaving Administration
 *   ({@link isLeavingAdmin}), never these switches.
 *
 * @module pages/Settings/useAdminLocation
 */
import { useLocation } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import { usePlaceNavigate, useReplaceAddress } from '../../utils/pathPlace'
import { ADMIN_PATH, adminBoardOf, adminPath, readAdminAddress } from './adminPaths'
import { visibleSections } from './adminTabs'
import type { AdminLocation, AdminSectionId, AdminTabId } from './adminTabs'

const BOARDS: AdminLocation = { tab: 'access', section: 'boards' }

/** The guard's `shouldBlock` for /admin: only leaving Administration (a path outside `/admin`) loses the brand draft. */
export const isLeavingAdmin = (_current: Location, next: Location): boolean =>
  next.pathname !== ADMIN_PATH && !next.pathname.startsWith(`${ADMIN_PATH}/`)

export function useAdminLocation(isAdmin: boolean, isPlatformAdmin: boolean) {
  const address = useLocation()
  const read = readAdminAddress(address, isAdmin, isPlatformAdmin)
  useReplaceAddress(read?.replaceWith ?? null)
  const move = usePlaceNavigate()
  const search = read?.replaceWith?.search ?? address.search
  const location: AdminLocation = read === null ? { tab: 'brand', section: null } : { tab: read.place.tab, section: read.place.section }
  const go = (next: AdminLocation) => { move({ pathname: adminPath(next), search }) }
  const selectTab = (next: AdminTabId) => { go({ tab: next, section: visibleSections(next, isAdmin, isPlatformAdmin)[0] ?? null }) }
  const selectSection = (next: AdminSectionId) => { go({ tab: location.tab, section: next }) }
  return { location, selectTab, selectSection }
}

/** The Boards section's open editor (`/admin/access/boards/<boardId>`) and the move that opens one (null: the list). */
export function useBoardInPath(): readonly [string | null, (boardId: string | null) => void] {
  const address = useLocation()
  const move = usePlaceNavigate()
  const open = (boardId: string | null) => { move({ pathname: adminPath(BOARDS, boardId), search: address.search }) }
  return [adminBoardOf(address.pathname), open]
}
