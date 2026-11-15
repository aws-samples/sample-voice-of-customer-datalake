/**
 * @fileoverview Agents → Connections' add dialog as its tests drive it: open it from the page, save it. Shared by the
 * GitHub and GitLab connection tests.
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** Open the add dialog (the page's "Add connection"): the dialog. */
export async function openAddConnection(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole('button', { name: 'Add connection' }))
  return screen.getByRole('dialog', { name: 'Add a repository connection' })
}

/** Press the dialog's "Save connection". */
export const saveConnection = (dialog: HTMLElement) =>
  userEvent.click(within(dialog).getByRole('button', { name: 'Save connection' }))
