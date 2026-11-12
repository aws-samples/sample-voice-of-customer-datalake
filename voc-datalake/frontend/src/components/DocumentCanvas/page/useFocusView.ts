/**
 * @fileoverview The document page's focus view ("Full screen"): on, the page has the whole window (the canvas and its
 * comments rail; the app's sidebar, header, the project's tabs and the documents list step aside, see focusView).
 *
 * - The address keeps it as `?view=focus`, written through the router in place (a reload keeps it): entering and
 *   leaving replace the page's entry, as the document's own `?doc=` does, so Back goes to the page before, never to
 *   an older version of a document saved in focus view.
 * - The bar's "Full screen" button toggles it, and so does Ctrl/⌘+Shift+F anywhere on the page; Escape leaves it when
 *   nothing else wants that Escape (a dialog, a menu, a list of options open, or a popover that took the key).
 * - Focus goes to the canvas on enter and back to the button on leave (not on load: a reload keeps focus where the
 *   browser puts it).
 *
 * @module components/DocumentCanvas/page/useFocusView
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { isFocusView, setFocusViewActive, withFocusView } from './focusView'
import type { RefObject } from 'react'

export interface FocusViewControls {
  readonly active: boolean
  readonly toggle: () => void
}

/** Anything open that owns an Escape of its own (the canvas's format bar too): the focus view leaves it alone. */
const ESCAPE_OWNERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="toolbar"]'

/** Is `target` inside the canvas's editable text (ProseMirror)? */
function inEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.ProseMirror') !== null
}

/** Ctrl/⌘+Shift+F. */
export function isFocusViewShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f'
}

/**
 * @param focusCanvas - puts focus in the canvas (on enter)
 * @param buttonRef - the bar's "Full screen" button: focus comes back to it when the view closes
 */
export function useFocusView(focusCanvas: () => void, buttonRef: RefObject<HTMLButtonElement | null>): FocusViewControls {
  const [params, setParams] = useSearchParams()
  const active = isFocusView(params)

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

  // In place, both ways: the page's entry is the document's (a save rewrites its `?doc=` in place too), so Back
  // never lands on a version older than the one on screen.
  const enter = useCallback(() => {
    setParams((prev) => withFocusView(prev, true), { replace: true })
  }, [setParams])
  const leave = useCallback(() => {
    setParams((prev) => withFocusView(prev, false), { replace: true })
  }, [setParams])
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
