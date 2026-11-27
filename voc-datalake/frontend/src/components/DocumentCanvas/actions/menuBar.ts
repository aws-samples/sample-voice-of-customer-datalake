/**
 * @fileoverview The document page's menu bar (Document · Edit · Format · Insert · Review · View): a row of WAI-ARIA
 * menu buttons (each its own Tab stop: Enter, Space or the arrows open it; inside, arrows / Home / End move and Escape
 * closes it with focus back on its button), plus the menu bar's own keys, handled once on the row:
 * - on a menu's button, ArrowLeft / ArrowRight move to the previous / next button (wrapping);
 * - inside an open menu, ArrowLeft / ArrowRight close it and open the neighbouring menu, on its first item.
 * Each button carries `data-menubar-trigger`, so the Document menu (ExportMenuShell) and the others
 * (CanvasMenu) take part alike.
 *
 * @module components/DocumentCanvas/actions/menuBar
 */
import type { KeyboardEvent } from 'react'

/** A menu's button in the bar: quiet text that shows its state while open. */
export const MENUBAR_TRIGGER_CLASS = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.8125rem] font-medium '
  + 'text-text hover:bg-bg-hover aria-expanded:bg-bg-hover focus-ring'

/** A menu of the bar: under its button, aligned to its start. */
export const MENUBAR_POPUP_CLASS = 'menu absolute left-0 top-full z-30 mt-1 w-64 max-w-[calc(100vw-2rem)]'

/** The attribute naming a menu button of the bar. */
const MENUBAR_TRIGGER_ATTRIBUTE = 'data-menubar-trigger'

function triggersOf(bar: HTMLElement): HTMLButtonElement[] {
  return [...bar.querySelectorAll<HTMLButtonElement>(`[${MENUBAR_TRIGGER_ATTRIBUTE}]`)]
}

/** The bar's ArrowLeft / ArrowRight (see the module's doc); every other key is the menu's own. */
export function onMenuBarKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const { target } = event
  const triggers = triggersOf(event.currentTarget)
  const count = triggers.length
  if (!(target instanceof HTMLElement) || count < 2) return
  const step = event.key === 'ArrowRight' ? 1 : -1
  const neighbour = (index: number) => triggers[(index + step + count) % count]
  const onTrigger = triggers.findIndex((trigger) => trigger === target)
  if (onTrigger >= 0) {
    event.preventDefault()
    neighbour(onTrigger)?.focus()
    return
  }
  if (target.closest('[role="menu"]') === null) return
  const open = triggers.findIndex((trigger) => trigger.getAttribute('aria-expanded') === 'true')
  if (open < 0) return
  event.preventDefault()
  // Its button closes it (focus stays for the next menu to take); the neighbour opens on its first item.
  triggers[open]?.click()
  neighbour(open)?.click()
}
