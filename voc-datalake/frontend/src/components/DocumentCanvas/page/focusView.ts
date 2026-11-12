/**
 * @fileoverview The document page's focus view ("Full screen"): its view option in the address and the one flag the
 * app shell reads to step aside.
 *
 * The address keeps it as the query option `?view=focus` (a view option, so a query string: the page's path and its
 * `?tab=` / `?doc=` stay as they are), read and written through the router (useFocusView). The flag says whether a
 * document page is in focus view right now: the page sets it while it is mounted and focused, and the shell (Layout:
 * the sidebar and the header; ProjectDetail: the project's header and tabs; DocumentsTab: the list) hides what it
 * owns while it is set. A `?view=focus` with no page to show (another tab, no document selected) changes nothing.
 *
 * Small on purpose: Layout loads with every page, the editor's bundle only on the Documents tab.
 *
 * @module components/DocumentCanvas/page/focusView
 */
import { useSyncExternalStore } from 'react'

/** The query parameter of the page's view option, and its focus value. */
const VIEW_PARAM = 'view'
const FOCUS_VALUE = 'focus'

/** Does the address ask for the focus view? */
export function isFocusView(params: URLSearchParams): boolean {
  return params.get(VIEW_PARAM) === FOCUS_VALUE
}

/** `params` with the focus view on or off; every other parameter kept as it was. */
export function withFocusView(params: URLSearchParams, on: boolean): URLSearchParams {
  const next = new URLSearchParams(params)
  if (on) next.set(VIEW_PARAM, FOCUS_VALUE)
  else next.delete(VIEW_PARAM)
  return next
}

/** The query string without the view option, for comparing two addresses. */
function withoutView(search: string): string {
  return withFocusView(new URLSearchParams(search), false).toString()
}

/**
 * Does going from `current` to `next` only enter or leave the focus view (same path, same query otherwise)? Such a
 * move keeps the page and its draft, so the unsaved-changes guard lets it through.
 */
export function onlyFocusViewChanged(
  current: Readonly<{ pathname: string; search: string }>, next: Readonly<{ pathname: string; search: string }>,
): boolean {
  return current.pathname === next.pathname && current.search !== next.search
    && withoutView(current.search) === withoutView(next.search)
}

const listeners = new Set<() => void>()
const flag = { active: false }

/** Set by the page (useFocusView) while it shows the focus view; false again when it leaves it or unmounts. */
export function setFocusViewActive(active: boolean): void {
  if (flag.active === active) return
  flag.active = active
  listeners.forEach((listener) => { listener() })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const snapshot = (): boolean => flag.active

/** Is a document page in focus view now? The shell hides its chrome while it is. */
export function useFocusViewActive(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
