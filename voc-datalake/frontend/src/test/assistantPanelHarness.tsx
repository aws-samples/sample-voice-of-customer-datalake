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
  await clickLauncherOpen(user)
  return user
}

/** Open the floating panel from the launcher and wait for it: the panel is a lazy chunk (AssistantRoot). */
export async function clickLauncherOpen(user: User): Promise<HTMLElement> {
  // Transform the chunk before the click, so the wait below is only React's one suspended render.
  await import('../assistant/components/AssistantPanel')
  await user.click(screen.getByRole('button', { name: 'Open assistant' }))
  return screen.findByRole('dialog')
}

/**
 * The assistant as the `/chat` page, with the app shell's AssistantRoot beside
 * it as in Layout (it renders nothing on `/chat`, but starts the restore of the
 * last conversation).
 */
export function renderChatPage(): User {
  const user = userEvent.setup()
  render(<><AssistantRoot /><Chat /></>, { initialEntries: ['/chat'] })
  return user
}

/** Type into the composer and press Enter. */
export async function typeAndSend(user: User, text: string): Promise<void> {
  await user.type(screen.getByLabelText('Message the assistant'), text)
  await user.keyboard('{Enter}')
}
