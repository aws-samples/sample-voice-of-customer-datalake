/**
 * @fileoverview A document card's menu in the documents list (DocumentCard): Open; for an editor Rename (a document
 * renamed by its writers: documentKinds.isRenamedInPlace) and Delete, the canvas's own Document menu items
 * (DocumentMenu). A viewer gets Open only: the edit items are left out, never shown disabled.
 *
 * It opens at the pointer on a right-click, under the card on the ContextMenu key or Shift+F10, and under the card's
 * "⋯" button (useCardContextMenu). A WAI-ARIA menu: the first item (ArrowUp on the "⋯": the last) takes the focus,
 * arrows / Home / End move, Escape closes it with focus back on what opened it, Tab closes it and moves on from
 * there; a press outside, a scroll or a resize closes it. Choosing an item closes it, then runs it.
 *
 * Fixed and in a portal (utils/fixedMenu), so the strip's sideways scroll below 1280 px never clips it; it is kept
 * inside the viewport, flipped above its anchor when there is no room below.
 *
 * @module pages/ProjectDetail/DocumentCardMenu
 */
import clsx from 'clsx'
import { FileText, MoreHorizontal, PenLine, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { CanvasMenuItem, type CanvasMenuEntry } from '../../components/DocumentCanvas/actions/CanvasMenu'
import { noCleanup } from '../../hooks/noCleanup'
import { useCloseOnViewportChange } from '../../hooks/useCloseOnViewportChange'
import { useOverlayFocus } from '../../hooks/useOverlayFocus'
import { placeFixedMenu, tabTargetFrom } from '../../utils/fixedMenu'
import { MENU_KEYS, rovingIndex } from '../../utils/rovingIndex'
import type { KeyboardEvent, RefObject } from 'react'
import type { TFunction } from 'i18next'
import type { CardContextMenu } from './useCardContextMenu'

/** What the card's menu offers: Open always; Rename and Delete only when given (an editor's, Rename by kind). */
export interface CardMenuActions {
  readonly onOpen: () => void
  readonly onRename?: () => void
  readonly onDelete?: () => void
  /** A delete is on its way: Delete waits (it stays in the menu's roving focus, as on the canvas). */
  readonly deleting: boolean
}

/** The menu's entries, in the canvas's order and wording (DocumentMenu). */
function cardMenuEntries(actions: CardMenuActions, t: TFunction<'projectDetail'>): CanvasMenuEntry[] {
  const entries: CanvasMenuEntry[] = [{ kind: 'action', id: 'open', label: t('documents.card.open'), icon: FileText, onSelect: actions.onOpen }]
  if (actions.onRename !== undefined) {
    entries.push({ kind: 'action', id: 'rename', label: t('canvas.menu.rename'), icon: PenLine, onSelect: actions.onRename })
  }
  if (actions.onDelete !== undefined) {
    entries.push({ kind: 'separator', id: 'delete-separator' }, {
      kind: 'action', id: 'delete', label: t('documents.deleteDocument'), icon: Trash2, onSelect: actions.onDelete,
      disabled: actions.deleting, danger: true,
    })
  }
  return entries
}

/**
 * While open, a press anywhere but the menu (and, opened from it, the "⋯" button, whose click toggles it) closes it.
 * Focus stays where the press put it.
 */
function useCloseOnPressOutside(open: boolean, close: () => void, menu: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null> | null): void {
  useEffect(() => {
    if (!open) return noCleanup
    const controller = new AbortController()
    document.addEventListener('mousedown', (event) => {
      const path = event.composedPath()
      const kept = [menu.current, trigger?.current ?? null].some((element) => element !== null && path.includes(element))
      if (!kept) close()
    }, { signal: controller.signal })
    return () => controller.abort()
  }, [open, close, menu, trigger])
}

/** The menu's own keys: arrows / Home / End move, Tab leaves it (for the control after, or before, its opener). */
function onMenuKeys(event: KeyboardEvent<HTMLDivElement>, menu: CardContextMenu): void {
  const opener = menu.returnFocusTo.current
  if (event.key === 'Tab') {
    if (opener === null) return
    event.preventDefault()
    menu.close()
    tabTargetFrom(opener, event.shiftKey).focus()
    return
  }
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  if (items.length === 0) return
  const next = rovingIndex(event.key, items.findIndex((item) => item === document.activeElement), items.length, MENU_KEYS)
  if (next === null) return
  event.preventDefault()
  items[next]?.focus()
}

/** The open menu, in a portal on the body. */
export function DocumentCardMenuPopup({ menu, menuId, label, actions }: Readonly<{
  menu: CardContextMenu
  menuId: string
  label: string
  actions: CardMenuActions
}>) {
  const { t } = useTranslation('projectDetail')
  const menuRef = useRef<HTMLDivElement>(null)
  const { opening, close } = menu
  const open = opening !== null
  useOverlayFocus(menuRef, open, { onClose: close, returnFocusTo: menu.returnFocusTo, initialFocus: '[role="menuitem"]' })
  useCloseOnViewportChange(open, close, menuRef)
  useCloseOnPressOutside(open, close, menuRef, opening?.fromButton === true ? menu.buttonRef : null)
  useLayoutEffect(() => {
    const element = menuRef.current
    if (opening === null || element === null) return
    placeFixedMenu(element, opening.anchor, opening.align)
    // Before the overlay's own focus (an effect after this one), which then finds the focus inside and leaves it.
    if (opening.focusLast) [...element.querySelectorAll<HTMLElement>('[role="menuitem"]')].at(-1)?.focus()
  }, [opening])
  if (opening === null) return null
  const choose = (run: () => void) => {
    close()
    run()
  }
  return createPortal(
    <div ref={menuRef} id={menuId} role="menu" aria-label={label} aria-orientation="vertical"
      onKeyDown={(event) => onMenuKeys(event, menu)} onContextMenu={(event) => event.preventDefault()}
      className="menu fixed z-[75] w-max min-w-44 max-w-[min(18rem,calc(100vw-1rem))]">
      {cardMenuEntries(actions, t).map((entry) => <CanvasMenuItem key={entry.id} entry={entry} choose={choose} />)}
    </div>,
    document.body,
  )
}

/**
 * The card's "⋯": shown on hover, on focus in the card, on the selected card, while its menu is open and always on a
 * touch screen (no hover there). Its name is "More actions"; the card's title is its description, so the list's
 * buttons are not all named after their cards twice.
 */
export function DocumentCardMoreButton({ buttonRef, open, menuId, selected, describedBy, onClick, onKeyDown }: Readonly<{
  buttonRef: RefObject<HTMLButtonElement | null>
  /** Its menu is open (opened from it). */
  open: boolean
  menuId: string
  selected: boolean
  describedBy: string
  onClick: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}>) {
  const { t } = useTranslation('projectDetail')
  return (
    <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} aria-label={t('documents.card.more')} aria-describedby={describedBy}
      title={t('documents.card.more')} onClick={onClick} onKeyDown={onKeyDown}
      className={clsx('icon-btn absolute right-1.5 top-1.5 p-1 focus-ring transition-opacity motion-reduce:transition-none',
        selected || open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100')}>
      <MoreHorizontal size={16} aria-hidden />
    </button>
  )
}
