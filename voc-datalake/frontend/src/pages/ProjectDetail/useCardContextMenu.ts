/**
 * @fileoverview A document card's context menu (DocumentCardMenu): whether it is open, where, and the three ways it
 * opens:
 * - a right-click on the card: at the pointer;
 * - the keyboard on the focused card, the ContextMenu key or Shift+F10: under the card;
 * - the card's "⋯" button: under it, right-aligned. Enter, Space or ArrowDown open it on the first item, ArrowUp on
 *   the last, and a second press closes it (APG menu button).
 *
 * Focus goes back to whichever opened it (the card, or its "⋯"). A key's own `contextmenu` event, which some
 * platforms send after the key, finds the menu already open and only suppresses the browser's menu.
 *
 * @module pages/ProjectDetail/useCardContextMenu
 */
import { useCallback, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, RefObject } from 'react'
import type { MenuAnchor } from '../../utils/fixedMenu'

/** Where the open menu is, and how it was opened. */
export interface CardMenuOpening {
  readonly anchor: MenuAnchor
  readonly align: 'start' | 'end'
  /** Opened by the "⋯" button: a press on it toggles the menu (its own click), never counts as outside. */
  readonly fromButton: boolean
  /** Opened with ArrowUp: the last item takes the focus. */
  readonly focusLast: boolean
}

export interface CardContextMenu {
  readonly opening: CardMenuOpening | null
  /** Where focus goes back when the menu closes (Escape, an item chosen): the element that opened it. */
  readonly returnFocusTo: RefObject<HTMLElement | null>
  readonly buttonRef: RefObject<HTMLButtonElement | null>
  readonly close: () => void
  /** The card's: a right-click opens the menu at the pointer. */
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void
  /** The card's: the ContextMenu key or Shift+F10 opens the menu under it. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  readonly onButtonClick: () => void
  readonly onButtonKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

/** The keyboard's way to a context menu (Windows, Linux, ChromeOS; screen readers send it too). */
function isContextMenuKey(event: KeyboardEvent): boolean {
  if (event.key === 'ContextMenu') return true
  return event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}

/** A point as an anchor: the menu opens with its corner there. */
function pointAt(x: number, y: number): MenuAnchor {
  return { top: y, bottom: y, left: x, right: x }
}

export function useCardContextMenu(): CardContextMenu {
  const [opening, setOpening] = useState<CardMenuOpening | null>(null)
  // Read by the handlers of the same gesture (the key, then its `contextmenu`) before a render could tell them.
  const openRef = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const returnFocusTo = useRef<HTMLElement | null>(null)

  const openFrom = useCallback((opener: HTMLElement, next: CardMenuOpening) => {
    returnFocusTo.current = opener
    openRef.current = true
    setOpening(next)
  }, [])
  const close = useCallback(() => {
    openRef.current = false
    setOpening(null)
  }, [])

  const onContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    // Open already: the keyboard opened it, and this is that key's own event (a press elsewhere closed any other).
    if (openRef.current) return
    openFrom(event.currentTarget, {
      anchor: pointAt(event.clientX, event.clientY), align: 'start', fromButton: false, focusLast: false,
    })
  }, [openFrom])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!isContextMenuKey(event)) return
    event.preventDefault()
    const card = event.currentTarget
    openFrom(card, { anchor: card.getBoundingClientRect(), align: 'start', fromButton: false, focusLast: false })
  }, [openFrom])

  const openFromButton = useCallback((focusLast: boolean) => {
    const button = buttonRef.current
    if (button === null) return
    openFrom(button, { anchor: button.getBoundingClientRect(), align: 'end', fromButton: true, focusLast })
  }, [openFrom])

  const onButtonClick = useCallback(() => {
    if (openRef.current) close()
    else openFromButton(false)
  }, [close, openFromButton])

  const onButtonKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (openRef.current || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    openFromButton(event.key === 'ArrowUp')
  }, [openFromButton])

  return { opening, returnFocusTo, buttonRef, close, onContextMenu, onKeyDown, onButtonClick, onButtonKeyDown }
}
