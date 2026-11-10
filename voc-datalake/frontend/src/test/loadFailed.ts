/** Test helper for the shared LoadFailed state (an announced alert with a "Try again" button). */
import { screen, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import enCommon from '../../public/locales/en/common.json'

/** Waits for the load-failure alert and presses its Try again button. */
export async function clickLoadFailedRetry(user: UserEvent): Promise<void> {
  const alert = await screen.findByRole('alert')
  await user.click(within(alert).getByRole('button', { name: enCommon.loadFailed.retry }))
}
