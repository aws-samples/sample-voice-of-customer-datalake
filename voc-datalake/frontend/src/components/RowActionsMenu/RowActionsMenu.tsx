/**
 * @fileoverview A row's "⋯" menu (docs/kiro-design-system.md › Choosing a component: "Actions on an item → menu from an
 * icon-btn"; ux-agents-redesign part 1 §2.3): an `icon-btn` named "Actions for <item>" (its Tooltip the same words, rule
 * 5) that opens a `menu` of `menu-item`s, with `menu-separator`s between groups and a destructive item in the danger
 * tone, last.
 *
 * The WAI-ARIA menu button pattern of the app's header menus (components/ProfileMenu/useMenuButton.ts): the first item
 * takes the focus (ArrowUp on the button: the last), the arrows, Home and End move, Escape closes it with the focus back
 * on the button, a press outside closes it. The menu is fixed and in a portal (utils/fixedMenu.ts), so a list card's
 * `overflow-hidden` never clips it; it opens under the button at its end, flipped above when there is no room, closes
 * when the page scrolls or the window resizes, and Tab leaves it for the control after (Shift+Tab: before) the button,
 * as if it were still beside it.
 *
 * An item that cannot act now stays in the menu and focusable (`aria-disabled`) with its reason as its visible text
 * (`reason`), never a hover hint (the design system's Tooltips content rule). Choosing an item closes the menu, focus
 * back on the button, then runs it.
 *
 * @module components/RowActionsMenu
 */
import { useId } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { MoreHorizontal } from 'lucide-react'
import { menuButtonParts, useMenuButton } from '../ProfileMenu/useMenuButton'
import { usePortalMenu } from '../../hooks/usePortalMenu'
import { Tooltip } from '../Tooltip/Tooltip'
import { tidyEntries } from './rowMenuEntries'
import type { KeyboardEvent, ReactNode } from 'react'
import type { RowMenuAction, RowMenuEntry } from './rowMenuEntries'

function MenuItem({ entry, choose }: Readonly<{ entry: RowMenuAction; choose: (entry: RowMenuAction) => void }>) {
  const Icon = entry.icon
  const blocked = entry.reason !== undefined
  return (
    <button type="button" role="menuitem" aria-disabled={blocked || undefined}
      className={clsx('menu-item flex w-full items-start gap-2 text-left', entry.danger === true && 'text-danger', blocked && 'opacity-60')}
      onClick={() => { if (!blocked) choose(entry) }}>
      {Icon === undefined ? null : <Icon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}
      <span className="min-w-0">
        <span className="block">{entry.label}</span>
        {blocked && <span className="block text-[12px] text-muted">{entry.reason}</span>}
      </span>
    </button>
  )
}

export function RowActionsMenu({ label, entries, className, face }: Readonly<{
  /** The button's and the menu's accessible name: "Actions for Issue triage". */
  label: string
  entries: readonly RowMenuEntry[]
  /** The button's classes: an `icon-btn` (the "⋯") unless a `face` is given, then its own (`btn btn-secondary btn-sm`). */
  className?: string
  /** A text button's visible face ("Run another flow ▾") in place of the "⋯": its words name it, no Tooltip. */
  face?: ReactNode
}>) {
  const menu = useMenuButton()
  const menuId = useId()
  const parts = menuButtonParts(menu, menuId, label)
  // (the trigger's native `title` is the header menus'; here the Tooltip names it: rule 16)
  const trigger = { ...parts.trigger, title: undefined }
  const { list } = parts
  const { open, close } = menu
  const onKeyDown = usePortalMenu(menu, 'end', (event: KeyboardEvent<HTMLDivElement>) => { list.onKeyDown?.(event) })
  const shown = tidyEntries(entries)
  if (shown.length === 0) return null
  const choose = (entry: RowMenuAction) => {
    close(true)
    entry.onSelect()
  }
  return (
    <>
      {face === undefined
        ? (
            <Tooltip kind="label" content={label}>
              <button {...trigger} className={clsx('icon-btn', className)}>
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
            </Tooltip>
          )
        : <button {...trigger} className={className}>{face}</button>}
      {open && createPortal(
        <div {...list} onKeyDown={onKeyDown} className="menu fixed z-[75] w-max min-w-44 max-w-[min(18rem,calc(100vw-1rem))]">
          {shown.map((entry) => (entry.kind === 'separator'
            ? <div key={entry.id} role="separator" className="menu-separator" />
            : <MenuItem key={entry.id} entry={entry} choose={choose} />))}
        </div>,
        document.body,
      )}
    </>
  )
}
