/** A keyboard-complete menu (role=menu): arrows, Home/End move, Enter/Space choose, Esc closes. */
import type { LucideIcon } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef } from 'react'
import { MENU_KEYS, rovingIndex } from '../../../utils/rovingIndex'

export interface MenuItem {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  readonly onSelect: () => void
  readonly disabled?: boolean
  /** Opens a submenu (announced as such). */
  readonly submenu?: boolean
}

interface MenuListProps {
  readonly label: string
  readonly items: readonly MenuItem[]
  readonly onClose: () => void
  readonly className?: string
}

export default function MenuList({ label, items, onClose, className }: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus()
  }, [items])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])]
    if (buttons.length === 0) return
    const index = Math.max(buttons.findIndex((button) => button === document.activeElement), 0)
    const next = rovingIndex(event.key, index, buttons.length, MENU_KEYS)
    if (next === null) return
    event.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <div ref={ref} role="menu" aria-label={label} className={className ?? 'canvas-menu'} onKeyDown={onKeyDown}>
      {items.map(({ id, label: itemLabel, icon: Icon, onSelect, disabled, submenu }) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={disabled}
          aria-haspopup={submenu ? 'menu' : undefined}
          className="canvas-menu__item"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onSelect}
        >
          <Icon aria-hidden="true" className="canvas-menu__icon" />
          <span>{itemLabel}</span>
        </button>
      ))}
    </div>
  )
}
