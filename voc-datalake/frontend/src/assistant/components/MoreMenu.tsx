/**
 * @fileoverview A "More actions" menu button (lucide MoreHorizontal) for the
 * assistant: the panel header's secondary actions and each conversation row's
 * Rename / Delete / Close. Every item has a VISIBLE label (wave 4: icon-only
 * actions were unlabelled and every rail row showed two icons that stole the
 * title's width).
 *
 * WAI-ARIA menu button pattern: the trigger has `aria-haspopup="menu"` and
 * `aria-expanded`; Enter / Space / ArrowDown open it on the first item, ArrowUp
 * on the last; arrows, Home and End move; Escape closes it and returns focus to
 * the trigger (and stops there, so the panel behind stays open); Tab or a click
 * outside closes it.
 *
 * The menu is `position: fixed` (a conversation list scrolls and would clip an
 * absolute menu): it is placed under the trigger, right-aligned, flipped above
 * when there is no room below and kept inside the viewport. An ancestor with a
 * transform or backdrop filter becomes the containing block of a fixed element,
 * so the placement is measured and corrected rather than assumed. Scrolling or
 * resizing closes it.
 *
 * @module assistant/components/MoreMenu
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import clsx from 'clsx'
import { Check, MoreHorizontal } from 'lucide-react'
import { useDisclosurePopover } from '../../hooks/useDismissOnOutside'
import { useOverlayFocus } from '../../hooks/useOverlayFocus'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'

export interface MoreMenuItem {
  readonly key: string
  readonly label: string
  readonly icon: ReactNode
  readonly onSelect: () => void
  readonly disabled?: boolean
  /** A toggle (menuitemcheckbox) when set. */
  readonly checked?: boolean
  readonly danger?: boolean
}

interface MoreMenuProps {
  /** The trigger's accessible name and tooltip. */
  readonly label: string
  readonly items: readonly MoreMenuItem[]
  readonly className?: string
  /** Lets a caller send focus back to the trigger later (after an inline rename). */
  readonly triggerRef?: RefObject<HTMLButtonElement | null>
  readonly iconSize?: number
}

/** Keep the menu this far from the viewport edges. */
const EDGE = 8
const GAP = 4

function placeMenu(menu: HTMLElement, trigger: HTMLElement): void {
  menu.style.top = '0px'
  menu.style.left = '0px'
  // Where (0, 0) lands: the containing block's origin in the viewport.
  const origin = menu.getBoundingClientRect()
  const anchor = trigger.getBoundingClientRect()
  const below = anchor.bottom + GAP
  const fitsBelow = below + origin.height <= window.innerHeight - EDGE
  const top = fitsBelow ? below : Math.max(EDGE, anchor.top - GAP - origin.height)
  const left = Math.min(Math.max(EDGE, anchor.right - origin.width), window.innerWidth - EDGE - origin.width)
  menu.style.top = `${top - origin.top}px`
  menu.style.left = `${left - origin.left}px`
}

function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  return menu === null ? [] : [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')]
}

/** Arrow / Home / End navigation inside the open menu. */
function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>, menu: HTMLElement | null): void {
  const items = enabledItems(menu)
  if (items.length === 0) return
  const current = items.findIndex((item) => item === document.activeElement)
  const targets: Record<string, number> = {
    ArrowDown: (current + 1) % items.length,
    ArrowUp: (current - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  }
  const next = targets[event.key]
  if (next === undefined) return
  event.preventDefault()
  items[next]?.focus()
}

function useCloseOnViewportChange(open: boolean, close: () => void, menu: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return undefined
    const onScroll = (event: Event) => {
      // Scrolling inside the menu itself (a long menu) keeps it open.
      if (event.target instanceof Node && menu.current?.contains(event.target) === true) return
      close()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close, menu])
}

function MenuEntry({ item, onDone }: Readonly<{ item: MoreMenuItem; onDone: () => void }>) {
  const toggle = item.checked !== undefined
  return (
    <button
      type="button"
      role={toggle ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={toggle ? item.checked : undefined}
      disabled={item.disabled}
      tabIndex={-1}
      onClick={() => {
        onDone()
        item.onSelect()
      }}
      className={clsx('menu-item w-full items-start text-left disabled:opacity-40', item.danger === true && 'text-danger')}
    >
      <span className="mt-0.5 flex-shrink-0" aria-hidden>{item.icon}</span>
      {/* Labels wrap (WCAG 1.4.10 reflow, longest locales): never truncated. */}
      <span className="min-w-0 flex-1 break-words">{item.label}</span>
      {item.checked === true && <Check size={14} className="mt-0.5 flex-shrink-0 text-accent-text" aria-hidden />}
    </button>
  )
}

export default function MoreMenu({ label, items, className, triggerRef, iconSize = 16 }: MoreMenuProps) {
  const popover = useDisclosurePopover()
  const menuRef = useRef<HTMLDivElement>(null)
  const { open, close, toggle, panelId, wrapper, trigger: ownTriggerRef } = popover
  // The first (or, opened with ArrowUp, the last) item takes focus on open.
  const focusLast = useRef(false)
  useOverlayFocus(menuRef, open, {
    onClose: close,
    closeOnFocusOut: true,
    returnFocusTo: ownTriggerRef,
    initialFocus: '[role^="menuitem"]:not([disabled])',
  })
  useCloseOnViewportChange(open, close, menuRef)
  useLayoutEffect(() => {
    const menu = menuRef.current
    const button = ownTriggerRef.current
    if (!open || menu === null || button === null) return
    placeMenu(menu, button)
    if (focusLast.current) enabledItems(menu).at(-1)?.focus()
    focusLast.current = false
  }, [open, ownTriggerRef])
  const setTrigger = (node: HTMLButtonElement | null) => {
    ownTriggerRef.current = node
    if (triggerRef !== undefined) triggerRef.current = node
  }

  return (
    <div ref={wrapper} className={clsx('relative flex-shrink-0', className)}>
      <button
        ref={setTrigger}
        type="button"
        onClick={toggle}
        onKeyDown={(event) => {
          if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
          event.preventDefault()
          focusLast.current = event.key === 'ArrowUp'
          toggle()
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={label}
        className="icon-btn"
      >
        <MoreHorizontal size={iconSize} aria-hidden />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={panelId}
          role="menu"
          aria-label={label}
          aria-orientation="vertical"
          onKeyDown={(event) => moveFocus(event, menuRef.current)}
          className="menu fixed z-[75] w-max min-w-44 max-w-[min(18rem,calc(100vw-1rem))]"
        >
          {items.map((item) => <MenuEntry key={item.key} item={item} onDone={close} />)}
        </div>
      )}
    </div>
  )
}
