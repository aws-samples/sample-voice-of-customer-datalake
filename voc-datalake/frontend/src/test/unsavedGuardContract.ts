/**
 * @fileoverview The ONE behavioural contract every editor under the shared
 * unsaved-changes guard must meet (E2E F6; 3.00.00 R2).
 *
 * R2: on /admin, Cancel in the dialog kept the URL but the brand draft was
 * gone — a server copy that landed while the dialog was open replaced it — so
 * the next leave went through unasked. /account and /agents behaved. Each
 * guarded editor's spec therefore runs this same script:
 *
 * 1. edit, 2. leave (the dialog opens), 3. let the server copy land / refetch
 * WHILE the dialog is open, 4. Cancel: the dialog closes, the editor stayed
 * put and the draft is still there, 5. leave again: the dialog opens again,
 * 6. Discard: the leave goes through.
 *
 * `guardedEditors.test.ts` checks that every module calling the guard has a
 * spec that runs this contract.
 *
 * @module test/unsavedGuardContract
 */
import { expect } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** The user-event session the contract drives the editor with. */
export type GuardUser = ReturnType<typeof userEvent.setup>

export interface GuardedEditorScenario {
  /** Mount the editor (under a data router for a page, so `useBlocker` is live). */
  readonly mount: () => Promise<void> | void
  /** Make the editor dirty. */
  readonly edit: (user: GuardUser) => Promise<void>
  /** The draft the edit produced is on screen. */
  readonly expectDraft: () => void
  /** Try to leave: a link, a tab, a dialog's close. */
  readonly leave: (user: GuardUser) => Promise<void>
  /** The editor is still where it was (URL, still mounted). */
  readonly expectStayed: () => void
  /** The leave went through (after Discard). */
  readonly expectLeft: () => Promise<void> | void
  /**
   * What lands while the dialog is open: the server copy changes and the
   * editor's query refetches, or a slow first load resolves. Default: nothing.
   */
  readonly whileDialogOpen?: () => Promise<void>
}

const guardDialog = () => screen.queryByRole('dialog', { name: 'Unsaved changes' })

async function openDialog(scenario: GuardedEditorScenario, user: GuardUser): Promise<HTMLElement> {
  await scenario.leave(user)
  return screen.findByRole('dialog', { name: 'Unsaved changes' })
}

/** Run the Cancel-keeps-the-draft-and-stays-guarded contract against one editor. */
export async function expectCancelKeepsDraftGuarded(scenario: GuardedEditorScenario): Promise<void> {
  const user = userEvent.setup()
  await scenario.mount()
  await scenario.edit(user)
  scenario.expectDraft()

  const first = await openDialog(scenario, user)
  if (scenario.whileDialogOpen !== undefined) {
    const landed = scenario.whileDialogOpen
    await act(async () => { await landed() })
  }
  await user.click(within(first).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(guardDialog()).not.toBeInTheDocument())
  scenario.expectStayed()
  scenario.expectDraft()

  const second = await openDialog(scenario, user)
  await user.click(within(second).getByRole('button', { name: 'Discard' }))
  await scenario.expectLeft()
}
