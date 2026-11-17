/**
 * @fileoverview Agents → Connections' add dialog as its tests drive it: open it from the page, save it. Shared by the
 * GitHub and GitLab connection tests. Since 7.52.00 a connection is added under More ways to connect: Connect manually
 * (advanced) → Add a GitHub connection, or GitLab → Add a GitLab connection (the dialog then starts on GitLab).
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const WAYS = {
  github: { way: /^Connect manually \(advanced\)/, add: 'Add a GitHub connection' },
  gitlab: { way: /^GitLab/, add: 'Add a GitLab connection' },
} as const

/** Unfold the way to add a connection on `host`: its Add button (enabled or not). */
export async function addConnectionButton(host: keyof typeof WAYS = 'github'): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole('button', { name: WAYS[host].way }))
  return screen.getByRole('button', { name: WAYS[host].add })
}

/** Open the add dialog on `host` (More ways to connect): the dialog. */
export async function openAddConnection(host: keyof typeof WAYS = 'github'): Promise<HTMLElement> {
  await userEvent.click(await addConnectionButton(host))
  return screen.getByRole('dialog', { name: 'Add a repository connection' })
}

/** Press the dialog's "Save connection". */
export const saveConnection = (dialog: HTMLElement) =>
  userEvent.click(within(dialog).getByRole('button', { name: 'Save connection' }))

/** Choose `item` in the "⋯" menu named `menu` ("Actions for example-org/web-app"). */
export async function chooseInRowMenu(menu: string, item: string): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: menu }))
  await userEvent.click(screen.getByRole('menuitem', { name: item }))
}
