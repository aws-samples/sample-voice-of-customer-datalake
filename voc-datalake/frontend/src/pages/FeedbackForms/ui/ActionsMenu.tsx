/**
 * @fileoverview The forms builder's ⋯ menus (a card's, a rule's, an option's, the header's): a WAI-ARIA menu button
 * (`components/ProfileMenu/useMenuButton`: arrow keys, Home/End, Escape back to the trigger) whose icon-only trigger
 * carries its name and a `title` (R5, R16). An item that is off says why in visible text under its label and
 * stays focusable (`aria-disabled`). The menu is fixed and in a portal (utils/fixedMenu.ts), so a scrolling pane or a
 * card's `overflow-hidden` never clips it (the last question card's menu in the builder's full-height list pane): it
 * opens under its trigger, flipped above it when there is no room, and closes when a scroll moves the trigger or the
 * window resizes; Tab leaves it for the control after the trigger. A `face` makes the trigger a text button ("Open in window
 * ▾", "+ Add language ▾") in place of the ⋯.
 *
 * @module pages/FeedbackForms/ui/ActionsMenu
 */
import { useId } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { MoreHorizontal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useFixedMenu } from './useFixedMenu'

export interface MenuAction {
  readonly label: string
  readonly onSelect: () => void
  readonly icon?: LucideIcon
  /** Why the item is off (shown under it); undefined: it is on. */
  readonly disabledReason?: string
  readonly danger?: boolean
}

export default function ActionsMenu({ label, items, className, face, faceClassName = 'btn btn-secondary btn-sm' }: Readonly<{
  /** The trigger's name ("More actions for question 2"). */
  label: string
  /** The items; null entries are separators. */
  items: readonly (MenuAction | null)[]
  className?: string
  /** A text trigger's visible face ("Open in window ▾") in place of the ⋯: its words show the name, no `title`. */
  face?: ReactNode
  /** The text trigger's classes (with `face` only). */
  faceClassName?: string
}>) {
  const { open, buttonRef, menuRef, toggle, close, onButtonKeyDown, onMenuKeyDown, leaveOnTab } = useFixedMenu('end')
  const menuId = useId()
  const pick = (item: MenuAction) => {
    if (item.disabledReason !== undefined) return
    close(true)
    item.onSelect()
  }
  // (the menu sits at the end of the page: Tab goes on from the trigger, as if the menu were still beside it)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => { if (!leaveOnTab(event)) onMenuKeyDown(event) }
  return (
    <div className={clsx('relative', className)}>
      <button title={face === undefined ? label : undefined} ref={buttonRef} type="button"
        className={face === undefined ? 'icon-btn' : faceClassName} aria-label={label} aria-haspopup="menu"
        aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={toggle} onKeyDown={onButtonKeyDown}>
        {face ?? <MoreHorizontal size={16} aria-hidden="true" />}
      </button>
      {open && createPortal(
        <div ref={menuRef} id={menuId} role="menu" aria-label={label} aria-orientation="vertical"
          onKeyDown={onKeyDown} className="menu fixed z-[75] w-60 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto animate-scale-in">
          {items.map((item, index) => (item === null
            ? <div key={`separator-${String(index)}`} role="separator" className="menu-separator" />
            : (
              <button key={item.label} type="button" role="menuitem" tabIndex={-1}
                aria-disabled={item.disabledReason === undefined ? undefined : true}
                className={clsx('menu-item flex w-full items-start gap-2 text-left', item.danger === true && 'text-danger',
                  item.disabledReason !== undefined && 'opacity-60')}
                onClick={() => pick(item)}>
                {item.icon !== undefined && <item.icon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}
                <span className="min-w-0">
                  <span className="block">{item.label}</span>
                  {item.disabledReason !== undefined && <span className="block text-[12px] text-muted">{item.disabledReason}</span>}
                </span>
              </button>
            )))}
        </div>,
        document.body,
      )}
    </div>
  )
}
