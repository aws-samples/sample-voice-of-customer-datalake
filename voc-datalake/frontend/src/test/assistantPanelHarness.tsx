/**
 * Rendering helpers shared by the assistant panel suites: the floating panel
 * opened from the launcher on a project page, the `/chat` page, and sending
 * a message from the composer.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from './test-utils'
import AssistantRoot from '../assistant/components/AssistantRoot'
import Chat from '../pages/Chat/Chat'

export type User = ReturnType<typeof userEvent.setup>

/** The floating panel, opened from the launcher on `/projects/p1`. */
export async function openPanel(): Promise<User> {
  const user = userEvent.setup()
  render(<AssistantRoot />, { initialEntries: ['/projects/p1'] })
  await user.click(screen.getByRole('button', { name: 'Open assistant' }))
  return user
}

/** The assistant as the `/chat` page. */
export function renderChatPage(): User {
  const user = userEvent.setup()
  render(<Chat />, { initialEntries: ['/chat'] })
  return user
}

/** Type into the composer and press Enter. */
export async function typeAndSend(user: User, text: string): Promise<void> {
  await user.type(screen.getByLabelText('Message the assistant'), text)
  await user.keyboard('{Enter}')
}
