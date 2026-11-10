/**
 * Test helpers for the conversation rows' "More actions" menu (SessionRows): since wave 4 a
 * row's Rename / Delete / Close live in one menu, so specs open it and pick an item by its
 * visible label.
 */
import { screen, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'

type Clicker = Pick<UserEvent, 'click'>
type Scope = Pick<typeof screen, 'findByRole'>

export type RowAction = 'Rename' | 'Delete' | 'Close' | 'Stop and close'

/** The row's menu button (its accessible name names the conversation). */
export function rowMenuButton(title: string, scope: Scope = screen): Promise<HTMLElement> {
  return scope.findByRole('button', { name: `More actions for “${title}”` })
}

/** Open the row's menu and return it. */
async function openRowMenu(user: Clicker, title: string, scope: Scope = screen): Promise<HTMLElement> {
  await user.click(await rowMenuButton(title, scope))
  return screen.findByRole('menu', { name: `More actions for “${title}”` })
}

/** Open the row's menu and pick one action. */
export async function rowAction(user: Clicker, title: string, action: RowAction, scope: Scope = screen): Promise<void> {
  const menu = await openRowMenu(user, title, scope)
  await user.click(within(menu).getByRole('menuitem', { name: action }))
}

/** The visible labels of a row's menu items. */
export async function rowMenuItems(user: Clicker, title: string, scope: Scope = screen): Promise<string[]> {
  const menu = await openRowMenu(user, title, scope)
  return within(menu).getAllByRole('menuitem').map((item) => item.textContent)
}
