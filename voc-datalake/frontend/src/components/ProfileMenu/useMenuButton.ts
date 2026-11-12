/**
 * @fileoverview WAI-ARIA menu button behaviour (APG "Menu Button" pattern):
 * open/close state, focus moves into the menu when it opens, arrow/Home/End
 * keys move between items, Escape (and Tab) close it, focus returns to the
 * button, and a pointer press outside closes it.
 * @module components/ProfileMenu/useMenuButton
 */
import {
  useCallback, useEffect, useRef, useState,
  type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type RefObject,
} from 'react'
import { noCleanup } from '../../hooks/noCleanup'
import { MENU_KEYS, rovingIndex } from '../../utils/rovingIndex'

/** Which item takes focus when the menu opens. */
type OpenFocus = 'first' | 'last'

interface MenuButton {
  readonly open: boolean
  readonly buttonRef: RefObject<HTMLButtonElement | null>
  readonly menuRef: RefObject<HTMLDivElement | null>
  readonly toggle: () => void
  /** Close the menu; `returnFocus` puts focus back on the button (Escape, item activation). */
  readonly close: (returnFocus?: boolean) => void
  readonly onButtonKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
  readonly onMenuKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}

/**
 * The trigger's and the menu's props for a menu button named `label` (the account menu, the workspace menu):
 * one place for the ARIA wiring, so two header menus cannot drift apart.
 */
export function menuButtonParts(menu: MenuButton, menuId: string, label: string): {
  trigger: ButtonHTMLAttributes<HTMLButtonElement> & { ref: RefObject<HTMLButtonElement | null> }
  list: HTMLAttributes<HTMLDivElement> & { ref: RefObject<HTMLDivElement | null> }
} {
  return {
    trigger: {
      ref: menu.buttonRef,
      type: 'button',
      onClick: menu.toggle,
      onKeyDown: menu.onButtonKeyDown,
      'aria-haspopup': 'menu',
      'aria-expanded': menu.open,
      'aria-controls': menu.open ? menuId : undefined,
      'aria-label': label,
      title: label,
    },
    list: {
      ref: menu.menuRef,
      id: menuId,
      role: 'menu',
      'aria-label': label,
      'aria-orientation': 'vertical',
      onKeyDown: menu.onMenuKeyDown,
    },
  }
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (menu === null) return []
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

export function useMenuButton(): MenuButton {
  const [open, setOpen] = useState(false)
  const [openFocus, setOpenFocus] = useState<OpenFocus>('first')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = useCallback((returnFocus = false) => {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }, [])

  const openWith = useCallback((focus: OpenFocus) => {
    setOpenFocus(focus)
    setOpen(true)
  }, [])

  const toggle = useCallback(() => {
    if (open) {
      close()
      return
    }
    openWith('first')
  }, [open, close, openWith])

  // Focus the first (or last) item once the menu is in the DOM.
  useEffect(() => {
    if (!open) return
    const items = menuItems(menuRef.current)
    const target = openFocus === 'first' ? items[0] : items.at(-1)
    target?.focus()
  }, [open, openFocus])

  // A press outside the button and the menu closes it (focus stays where the press put it).
  useEffect(() => {
    if (!open) return noCleanup
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) === true || buttonRef.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const onButtonKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    openWith(event.key === 'ArrowDown' ? 'first' : 'last')
  }, [openWith])

  const onMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      close()
      return
    }
    const items = menuItems(menuRef.current)
    if (items.length === 0) return
    const current = items.findIndex((item) => item === document.activeElement)
    const next = rovingIndex(event.key, current, items.length, MENU_KEYS)
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }, [close])

  return { open, buttonRef, menuRef, toggle, close, onButtonKeyDown, onMenuKeyDown }
}
