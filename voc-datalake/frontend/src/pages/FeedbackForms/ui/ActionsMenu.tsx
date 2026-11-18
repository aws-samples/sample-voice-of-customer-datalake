/**
 * @fileoverview The forms builder's ⋯ menus (a card's, a rule's, an option's, the header's): a WAI-ARIA menu button
 * (`components/ProfileMenu/useMenuButton`: arrow keys, Home/End, Escape back to the trigger) whose icon-only trigger
 * carries its name and a label Tooltip (R5, R16). An item that is off says why in visible text under its label and
 * stays focusable (`aria-disabled`).
 *
 * @module pages/FeedbackForms/ui/ActionsMenu
 */
import { useId } from 'react'
import clsx from 'clsx'
import { MoreHorizontal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useMenuButton } from '../../../components/ProfileMenu/useMenuButton'
import { Tooltip } from '../../../components/Tooltip/Tooltip'

export interface MenuAction {
  readonly label: string
  readonly onSelect: () => void
  readonly icon?: LucideIcon
  /** Why the item is off (shown under it); undefined: it is on. */
  readonly disabledReason?: string
  readonly danger?: boolean
}

export default function ActionsMenu({ label, items, className }: Readonly<{
  /** The trigger's name ("More actions for question 2"). */
  label: string
  /** The items; null entries are separators. */
  items: readonly (MenuAction | null)[]
  className?: string
}>) {
  const { open, buttonRef, menuRef, toggle, close, onButtonKeyDown, onMenuKeyDown } = useMenuButton()
  const menuId = useId()
  const pick = (item: MenuAction) => {
    if (item.disabledReason !== undefined) return
    close(true)
    item.onSelect()
  }
  return (
    <div className={clsx('relative', className)}>
      <Tooltip kind="label" content={label}>
        <button ref={buttonRef} type="button" className="icon-btn" aria-label={label} aria-haspopup="menu"
          aria-expanded={open} aria-controls={open ? menuId : undefined}
          onClick={toggle} onKeyDown={onButtonKeyDown}>
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      {open && (
        <div ref={menuRef} id={menuId} role="menu" aria-label={label} aria-orientation="vertical"
          onKeyDown={onMenuKeyDown} className="menu absolute right-0 top-full z-30 mt-1 w-60 animate-scale-in">
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
        </div>
      )}
    </div>
  )
}
