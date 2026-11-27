/**
 * @fileoverview The controls of the document page's toolbar (DocumentToolbar), a WAI-ARIA `toolbar`:
 *
 * - its roving focus (useRovingToolbar): one Tab stop for the whole row, the arrow keys, Home and End;
 * - `ToolbarButton`: an icon button named by `aria-label`, with its tooltip (`role="tooltip"`, its description, shown on
 *   hover and on keyboard focus), its name also beside the icon when it is one of the AI flows (`text`); a toggle says
 *   whether it is on with `aria-pressed`; a count shows as a badge (the count is in the name, so it is announced). A
 *   disabled item stays focusable (`aria-disabled`, APG) and says why in its tooltip.
 * - `ToolbarMenu`: a menu button of the row (the version picker, "⋯"), its entries drawn as the menu bar's
 *   (CanvasMenuEntries).
 *
 * @module components/DocumentCanvas/actions/toolbarControls
 */
import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import { useId } from 'react'
import { CanvasMenuEntries } from './CanvasMenu'
import type { ReactNode, RefObject } from 'react'
import type { RovingItem } from './useRovingToolbar'
import type { CanvasMenuEntry } from './CanvasMenu'
import type { ToolbarControl } from './toolbarItems'
import type { useMenuButton } from '../../ProfileMenu/useMenuButton'

type MenuButtonState = ReturnType<typeof useMenuButton>

/** An item of the row: a square icon button, or (`wide`) one with its text. */
const BUTTON_CLASS = 'group relative inline-flex h-8 items-center justify-center gap-1 rounded-md text-muted transition-colors '
  + 'hover:bg-bg-hover hover:text-text focus-ring aria-pressed:bg-accent-subtle aria-pressed:text-accent-text '
  + 'aria-expanded:bg-bg-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent'

/** The tooltip under an item, at its end (the row sits at the end of the page's header): on hover and on focus. */
const TIP_CLASS = 'pointer-events-none absolute right-0 top-full z-40 mt-1.5 hidden w-max max-w-64 rounded-md bg-text-strong '
  + 'px-2 py-1 text-left text-xs font-normal leading-snug text-card shadow-md whitespace-normal '
  + 'group-hover:block group-focus-visible:block'

export function ToolbarTip({ id, children }: Readonly<{ id: string; children: ReactNode }>) {
  return <span id={id} role="tooltip" className={TIP_CLASS}>{children}</span>
}

function toolbarButtonClass(wide: boolean): string {
  return clsx(BUTTON_CLASS, wide ? 'px-2 text-[0.8125rem] font-medium' : 'w-8')
}

interface ToolbarButtonProps extends ToolbarControl {
  readonly rove: RovingItem
  readonly buttonRef?: RefObject<HTMLButtonElement | null>
  readonly onClick: () => void
}

/** What a button shows: its icon (a spinner while it runs), its name beside it (`text`), its count. */
function ButtonFace({ label, icon: Icon, busy, text, badge }: Readonly<{
  label: string; icon: ToolbarControl['icon']; busy: boolean; text: boolean; badge?: number
}>) {
  return (
    <>
      {busy ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
      {/* The same words as its name (`aria-label`), so what is seen is what is announced. */}
      {text ? <span aria-hidden="true" className="whitespace-nowrap">{label}</span> : null}
      {badge === undefined || badge === 0 ? null : (
        <span aria-hidden="true" data-testid="toolbar-badge"
          className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent px-1 font-mono text-[10px] font-semibold leading-4 text-accent-fg">
          {badge}
        </span>
      )}
    </>
  )
}

export function ToolbarButton({
  rove, label, hint, icon, pressed, badge, disabled = false, busy = false, opensDialog = false, keyShortcuts, buttonRef,
  text = false, onClick,
}: ToolbarButtonProps) {
  const tipId = useId()
  const inert = disabled || busy
  return (
    // Not `disabled`: a disabled item could not take the row's roving focus (APG: it stays focusable, its tooltip says why).
    <button ref={buttonRef} type="button" {...rove} className={toolbarButtonClass(text)} aria-label={label}
      aria-describedby={tipId} aria-pressed={pressed} aria-disabled={inert ? true : undefined}
      aria-haspopup={opensDialog ? 'dialog' : undefined} aria-keyshortcuts={keyShortcuts}
      onClick={inert ? undefined : onClick}>
      <ButtonFace label={label} icon={icon} busy={busy} text={text} badge={badge} />
      <ToolbarTip id={tipId}>{hint}</ToolbarTip>
    </button>
  )
}

interface ToolbarMenuProps {
  /** The menu button's state (useMenuButton): its owner reads whether it is open (the versions load while it is). */
  readonly menu: MenuButtonState
  readonly rove: RovingItem
  /** The menu button's name (and the menu's). */
  readonly label: string
  readonly hint: string
  /** What the button shows: an icon, or a short text (the version shown). */
  readonly face: ReactNode
  readonly wide?: boolean
  /** Read while the menu is open. */
  readonly entries: () => readonly CanvasMenuEntry[]
  /** A line above the entries (the versions loading, or why they could not be). */
  readonly notice?: string | null
}

export function ToolbarMenu({ menu, rove, label, hint, face, wide = false, entries, notice }: ToolbarMenuProps) {
  const { open, buttonRef, menuRef, toggle, choose, onButtonKeyDown, onMenuKeyDown } = menu
  const menuId = useId()
  const tipId = useId()
  return (
    <div className="relative">
      <button ref={buttonRef} type="button" {...rove} className={toolbarButtonClass(wide)} aria-label={label}
        aria-describedby={open ? undefined : tipId} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} onClick={toggle} onKeyDown={onButtonKeyDown}>
        {face}
        {/* A tooltip over an open menu would cover its first entries. */}
        {open ? null : <ToolbarTip id={tipId}>{hint}</ToolbarTip>}
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} role="menu" aria-label={label} aria-orientation="vertical" onKeyDown={onMenuKeyDown}
          className="menu absolute right-0 top-full z-30 mt-1 w-64 max-w-[calc(100vw-2rem)]">
          {notice === undefined || notice === null ? null : (
            <p role="presentation" className="px-3 py-1.5 text-xs text-muted">{notice}</p>
          )}
          <CanvasMenuEntries entries={entries()} choose={choose} />
        </div>
      ) : null}
    </div>
  )
}
