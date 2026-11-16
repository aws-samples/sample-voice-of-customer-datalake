/**
 * @fileoverview The document page's focus view ("Full screen"): the one flag the app shell reads to step aside.
 *
 * The address keeps it as the document path's `/focus` (pages/ProjectDetail/projectPaths.ts:
 * `/projects/<id>/documents/<docId>/focus`), read and written through the router (useFocusView). The flag says whether
 * a document page is in focus view right now: the page sets it while it is mounted and focused, and the shell (Layout:
 * the sidebar and the header; ProjectDetail: the project's header and tabs; DocumentsTab: the list) hides what it owns
 * while it is set.
 *
 * Small on purpose: Layout loads with every page, the editor's bundle only on the Documents tab.
 *
 * @module components/DocumentCanvas/page/focusView
 */
import { useSyncExternalStore } from 'react'

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
