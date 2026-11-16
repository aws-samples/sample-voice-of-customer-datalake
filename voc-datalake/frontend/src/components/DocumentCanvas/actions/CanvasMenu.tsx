/**
 * @fileoverview One menu of the document page's menu bar (Edit, Format, Insert, View; menuBar.ts): a WAI-ARIA menu
 * button over a list of entries — actions (`menuitem`, with their keyboard shortcut shown and in
 * `aria-keyshortcuts`), toggles (`menuitemcheckbox`) and separators. The entries are read when the menu renders open,
 * so what can run (Undo with nothing to undo) is the text's state at that moment. A disabled entry stays in the
 * menu's roving focus (APG) and does nothing. Choosing an entry closes the menu and puts focus back on its button,
 * then runs it (an editor command takes the focus back to the text; a toggle leaves it on the button).
 *
 * @module components/DocumentCanvas/actions/CanvasMenu
 */
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useId } from 'react'
import { useMenuButton } from '../../ProfileMenu/useMenuButton'
import { MENUBAR_POPUP_CLASS, MENUBAR_TRIGGER_CLASS } from './menuBar'
import { shortcutKeys, shortcutText, type Shortcut } from './menuShortcuts'
import type { LucideIcon } from 'lucide-react'

interface EntryBase {
  readonly id: string
  readonly label: string
  readonly shortcut?: Shortcut
}

interface MenuAction extends EntryBase {
  readonly kind: 'action'
  readonly icon: LucideIcon
  readonly onSelect: () => void
  readonly disabled?: boolean
  /** A destructive action (Delete): drawn in the danger colour. */
  readonly danger?: boolean
}

interface MenuToggle extends EntryBase {
  readonly kind: 'toggle'
  readonly checked: boolean
  readonly onToggle: () => void
}

export type CanvasMenuEntry = MenuAction | MenuToggle | { readonly kind: 'separator'; readonly id: string }

interface CanvasMenuProps {
  readonly label: string
  /** Read while the menu is open (see the module's doc). */
  readonly entries: () => readonly CanvasMenuEntry[]
}

const ITEM_CLASS = 'menu-item py-2.5 sm:py-1.5 active:bg-bg-hover'

function ShortcutHint({ shortcut }: Readonly<{ shortcut?: Shortcut }>) {
  if (shortcut === undefined) return null
  return <kbd aria-hidden="true" className="ml-auto pl-3 font-sans text-xs text-muted whitespace-nowrap">{shortcutText(shortcut)}</kbd>
}

/**
 * One entry of a menu (`role="menu"`): CanvasMenu's, and the documents list's card menu (DocumentCardMenu). `choose`
 * closes the menu, then runs the entry.
 */
export function CanvasMenuItem({ entry, choose }: Readonly<{ entry: CanvasMenuEntry; choose: (run: () => void) => void }>) {
  if (entry.kind === 'separator') return <hr className="menu-separator border-0" />
  const keys = entry.shortcut === undefined ? undefined : shortcutKeys(entry.shortcut)
  if (entry.kind === 'toggle') {
    return (
      <button type="button" role="menuitemcheckbox" aria-checked={entry.checked} aria-keyshortcuts={keys}
        className={ITEM_CLASS} onClick={() => choose(entry.onToggle)}>
        <span aria-hidden="true" className="inline-flex size-4 flex-shrink-0 items-center justify-center">
          {entry.checked ? <Check size={14} /> : null}
        </span>
        <span className="truncate">{entry.label}</span>
        <ShortcutHint shortcut={entry.shortcut} />
      </button>
    )
  }
  const Icon = entry.icon
  const disabled = entry.disabled === true
  return (
    // Not `disabled`: a disabled item could not take the menu's roving focus (APG: disabled items stay focusable).
    <button type="button" role="menuitem" aria-disabled={disabled ? true : undefined} aria-keyshortcuts={keys}
      className={clsx(ITEM_CLASS, disabled && 'text-muted cursor-default hover:bg-transparent', entry.danger === true && !disabled && 'text-danger')}
      onClick={disabled ? undefined : () => choose(entry.onSelect)}>
      <Icon size={16} className="flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{entry.label}</span>
      <ShortcutHint shortcut={entry.shortcut} />
    </button>
  )
}

export default function CanvasMenu({ label, entries }: CanvasMenuProps) {
  const { open, buttonRef, menuRef, toggle, close, onButtonKeyDown, onMenuKeyDown } = useMenuButton()
  const menuId = useId()
  const triggerId = useId()
  const choose = (run: () => void) => {
    close(true)
    run()
  }
  return (
    <div className="relative">
      <button ref={buttonRef} id={triggerId} type="button" className={MENUBAR_TRIGGER_CLASS}
        data-menubar-trigger="" aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} onClick={toggle} onKeyDown={onButtonKeyDown}>
        {label}
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} role="menu" aria-labelledby={triggerId} aria-orientation="vertical"
          onKeyDown={onMenuKeyDown} className={MENUBAR_POPUP_CLASS}>
          {entries().map((entry) => <CanvasMenuItem key={entry.id} entry={entry} choose={choose} />)}
        </div>
      ) : null}
    </div>
  )
}
