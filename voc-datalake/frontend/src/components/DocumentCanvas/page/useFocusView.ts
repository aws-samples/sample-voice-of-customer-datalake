/**
 * @fileoverview The document page's focus view ("Full screen"): on, the page has the whole window (the canvas and its
 * comments rail; the app's sidebar, header, the project's tabs and the documents list step aside, see focusView).
 *
 * - The address keeps it as the document path's `/focus` (`…/documents/<docId>/focus`, `…/v/<n>/focus`: a reload keeps
 *   it): entering and leaving are history entries, so Back leaves full screen and Forward comes back to it. A save in
 *   full screen replaces the entry (useDocumentSelection), and an entry left on a version the page has moved past opens
 *   on the latest, with that version read-only.
 * - The toolbar's "Full screen" button toggles it, and so does Ctrl/⌘+Shift+F anywhere on the page; Escape leaves it when
 *   nothing else wants that Escape (a dialog, a menu, a list of options open, or a popover that took the key).
 * - Focus goes to the canvas on enter and back to the button on leave (not on load: a reload keeps focus where the
 *   browser puts it).
 *
 * @module components/DocumentCanvas/page/useFocusView
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { setFocusViewActive } from './focusView'
import type { RefObject } from 'react'

export interface FocusViewControls {
  readonly active: boolean
  readonly toggle: () => void
}

/**
 * Anything open that owns an Escape of its own (the canvas's format bar too): the focus view leaves it alone. The
 * page's own toolbar (DocumentToolbar, `data-document-toolbar`) is always there and owns no Escape.
 */
const ESCAPE_OWNERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], '
  + '[role="toolbar"]:not([data-document-toolbar])'

/** Is `target` inside the canvas's editable text (ProseMirror)? */
function inEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.ProseMirror') !== null
}

/** Ctrl/⌘+Shift+F. */
export function isFocusViewShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f'
}

/**
 * @param active - the address asks for the focus view (`/focus`)
 * @param setActive - goes to the page's address with or without it (a history entry)
 * @param focusCanvas - puts focus in the canvas (on enter)
 * @param buttonRef - the toolbar's "Full screen" button: focus comes back to it when the view closes
 */
export function useFocusView(
  active: boolean, setActive: (on: boolean) => void, focusCanvas: () => void, buttonRef: RefObject<HTMLButtonElement | null>,
): FocusViewControls {
  // Before paint: the shell's chrome is never drawn around a page that is in focus view.
  useLayoutEffect(() => { setFocusViewActive(active) }, [active])
  useLayoutEffect(() => () => { setFocusViewActive(false) }, [])

  const shown = useRef(active)
  useEffect(() => {
    if (shown.current === active) return
    shown.current = active
    if (active) focusCanvas()
    else buttonRef.current?.focus()
  }, [active, focusCanvas, buttonRef])

  const enter = useCallback(() => { setActive(true) }, [setActive])
  const leave = useCallback(() => { setActive(false) }, [setActive])
  const toggle = active ? leave : enter

  useEffect(() => {
    // Whether something that owns Escape was open when the key arrived (capture phase: before the popover handling
    // it closes itself). The canvas's own editor marks every Escape handled, so `defaultPrevented` alone cannot say.
    const owned = new WeakSet<KeyboardEvent>()
    const onCapture = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.querySelector(ESCAPE_OWNERS) !== null) owned.add(event)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (isFocusViewShortcut(event)) {
        event.preventDefault()
        toggle()
        return
      }
      if (!active || event.key !== 'Escape' || owned.has(event)) return
      // A popover outside the text that took the key (it stops it, or prevents it) keeps it.
      if (event.defaultPrevented && !inEditor(event.target)) return
      event.preventDefault()
      leave()
    }
    window.addEventListener('keydown', onCapture, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onCapture, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [active, toggle, leave])

  return { active, toggle }
}
