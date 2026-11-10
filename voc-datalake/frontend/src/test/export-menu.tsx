/**
 * @fileoverview Spec support for the menus built on `ExportMenuShell`.
 *
 * Every export-menu scenario starts the same way: mount the menu, press the
 * kebab trigger, then act on a menu item. The helpers here hold that opening
 * sequence so the document and persona specs state only what differs.
 */
import type { ReactElement } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'

/** Mount `ui` and return the trigger button (matched by its accessible name). */
export function renderExportMenu(ui: ReactElement, triggerName: string | RegExp): HTMLElement {
  render(ui)
  return screen.getByRole('button', { name: triggerName })
}

/** Mount `ui`, open the menu through its trigger and return the user session. */
export async function openExportMenu(ui: ReactElement, triggerName: string | RegExp): Promise<UserEvent> {
  const user = userEvent.setup()
  await user.click(renderExportMenu(ui, triggerName))
  return user
}

/** Mount `ui` next to an "Outside" button, open the menu, and click outside it. */
export async function openThenClickOutside(ui: ReactElement, triggerName: string | RegExp): Promise<void> {
  const user = await openExportMenu(
    <div>
      {ui}
      <button>Outside</button>
    </div>,
    triggerName,
  )
  // Throws if the menu did not open, so the caller's "closed" assertion cannot pass vacuously.
  screen.getByRole('menu')
  await user.click(screen.getByRole('button', { name: /outside/i }))
}
