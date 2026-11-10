/**
 * @fileoverview Which Administration tab and section is open: the URL is the
 * source of truth (`?tab=&section=`, new or pre-5.09 ids, {@link resolveAdminLocation}).
 *
 * - A tab or section switch PUSHES the canonical query, so Back returns to the
 *   previous place and a copied link opens where the user was.
 * - `redirectTo` is the canonical query when the loaded link was not canonical;
 *   the page renders it as a replacing `<Navigate>` (no history entry).
 * - Only `tab` / `section` / `board` are rewritten: any other param (the review
 *   modal's `?review=`) survives a switch or a canonical redirect. `board` (the
 *   Boards section's open editor, `&board=<id>`) lives only inside that section:
 *   a switch drops it, a canonical redirect keeps it when it still lands there.
 * - The brand draft lives at page level, so the page's unsaved-changes guard
 *   blocks only a path change ({@link isLeavingAdmin}), never these switches.
 *
 * @module pages/Settings/useAdminLocation
 */
import { useSearchParams } from 'react-router-dom'
import { withOwnedParams } from '../../utils/searchParams'
import type { Location } from 'react-router-dom'
import { canonicalSearch, resolveAdminLocation, visibleSections } from './adminTabs'
import type { AdminLocation, AdminSectionId, AdminTabId } from './adminTabs'

const OWNED_PARAMS: readonly string[] = ['tab', 'section', 'board']

/** `?<canonical>` (other params kept) when `tab` / `section` are not the canonical form of where they lead, else null. */
function redirectFor(current: URLSearchParams, isAdmin: boolean): string | null {
  const tab = current.get('tab')
  const section = current.get('section')
  if (tab === null) return null
  const resolved = resolveAdminLocation(tab, section, isAdmin)
  const canonical = new URLSearchParams(canonicalSearch(resolved))
  if (canonical.get('tab') === tab && canonical.get('section') === section) return null
  const board = current.get('board')
  if (board !== null && resolved.section === 'boards') canonical.set('board', board)
  return `?${withOwnedParams(current, OWNED_PARAMS, canonical).toString()}`
}

/** The guard's `shouldBlock` for /admin: only leaving the page (a path change) can lose the brand draft. */
export const isLeavingAdmin = (current: Location, next: Location): boolean => current.pathname !== next.pathname

export function useAdminLocation(isAdmin: boolean) {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab')
  const section = searchParams.get('section')
  const location = resolveAdminLocation(tab, section, isAdmin)
  const redirectTo = redirectFor(searchParams, isAdmin)

  /** Push `next` unless it is already the place in the URL (re-clicking the open tab adds no entry). */
  const go = (next: AdminLocation) => {
    const target = withOwnedParams(searchParams, OWNED_PARAMS, new URLSearchParams(canonicalSearch(next)))
    if (target.toString() !== searchParams.toString()) setSearchParams(target)
  }
  const selectTab = (next: AdminTabId) => go({ tab: next, section: visibleSections(next, isAdmin)[0] ?? null })
  const selectSection = (next: AdminSectionId) => go({ tab: location.tab, section: next })
  return { location, selectTab, selectSection, redirectTo }
}
