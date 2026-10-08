/**
 * Assistant panel layout and navigation with the transport mocked: the wide
 * (page / full screen) sidebar and the header buttons it replaces from `lg` up,
 * the error line, export labels, restoring the last conversation after a
 * reload, and that starting or picking a conversation closes the drawer and
 * drops a stale suggestion draft.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { EventType } from '@ag-ui/core'
import { screen, within } from '@testing-library/react'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import type { ApprovalCardProps } from '../types'

const agent = await vi.hoisted(async () => (await import('@test/assistantDoubles')).createScriptedRunAgent())
const { scripts } = agent

vi.mock('../agui/client', agent.clientModule)
vi.mock('../sessions/sessionsApi', agent.sessionsModule)

vi.mock('../approvals/ApprovalCard', () => ({
  default: ({ toolCall }: ApprovalCardProps) => <div data-testid="approval-card">{toolCall.name}</div>,
}))

vi.mock('./exportMarkdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./exportMarkdown')>()
  return { ...actual, downloadMarkdown: vi.fn() }
})

import { getSession } from '../sessions/sessionsApi'
import { downloadMarkdown } from './exportMarkdown'
import { useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { textRunEvents as textRun } from '@test/assistantDoubles'
import { openPanel, renderChatPage } from '@test/assistantPanelHarness'
import type { User } from '@test/assistantPanelHarness'

const SUGGESTION = 'Summarize this project and its personas'

function composer(): HTMLElement {
  return screen.getByLabelText('Message the assistant')
}

async function send(user: User, text: string, answer: string) {
  scripts.push(textRun(`r-${answer}`, `a-${answer}`, answer))
  await user.type(composer(), text)
  await user.keyboard('{Enter}')
  await screen.findByText(answer)
}

/** Pick the suggestion (sets the draft) and send it, leaving the draft state set but the composer empty. */
async function sendSuggestion(user: User) {
  scripts.push(textRun('r-s', 'a-s', 'Suggestion answered.'))
  await user.click(screen.getByRole('button', { name: SUGGESTION }))
  expect(composer()).toHaveValue(SUGGESTION)
  await user.click(composer())
  await user.keyboard('{Enter}')
  await screen.findByText('Suggestion answered.')
}

function drawer(): HTMLElement | null {
  return screen.queryByRole('complementary', { name: 'Past conversations' })
}

/** The open-conversation row (not its close button) for the given first question. */
function openRow(scope: HTMLElement, question: string): HTMLElement {
  const list = within(scope).getByRole('list', { name: 'Open' })
  return within(list).getByRole('button', { name: new RegExp(`^(New reply )?${question}$`) })
}

/** Open the sessions drawer and switch to the open conversation that began with `question`. */
async function pickFromDrawer(user: User, question: string) {
  await user.click(screen.getByRole('button', { name: 'Past conversations' }))
  const open = drawer()
  if (open === null) throw new Error('drawer did not open')
  await user.click(openRow(open, question))
}

describe('AssistantPanel layout', () => {
  beforeEach(() => stubElementScrollIntoView())

  beforeEach(() => {
    scripts.length = 0
    vi.mocked(getSession).mockClear()
    vi.mocked(downloadMarkdown).mockClear()
    useThreadStore.getState().reset()
    useAssistantUiStore.getState().reset()
  })

  describe('wide sidebar', () => {
    it('on /chat shows the sidebar only from lg up', () => {
      renderChatPage()
      const nav = screen.getByRole('navigation', { name: 'Conversations' })
      expect(nav).toHaveClass('hidden', 'lg:flex')
    })

    it('on /chat titles the sidebar with an h2 and its groups with h3, so no level is skipped (E2E F9)', () => {
      renderChatPage()
      const nav = screen.getByRole('navigation', { name: 'Conversations' })
      expect(within(nav).getByRole('heading', { level: 2, name: 'Conversations' })).toHaveClass('sr-only')
      expect(within(nav).getByRole('heading', { level: 3, name: 'History' })).toBeInTheDocument()
      expect(within(nav).queryByRole('heading', { level: 4 })).not.toBeInTheDocument()
    })

    it('on /chat hides the header New chat and Past conversations from lg up, where the sidebar replaces them', () => {
      renderChatPage()
      expect(screen.getByRole('button', { name: 'New chat' })).toHaveClass('lg:hidden')
      expect(screen.getByRole('button', { name: 'Past conversations' })).toHaveClass('lg:hidden')
    })

    it('in the floating bubble has no sidebar and keeps the header buttons at every width', async () => {
      await openPanel()
      expect(screen.queryByRole('navigation', { name: 'Conversations' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'New chat' })).not.toHaveClass('lg:hidden')
      expect(screen.getByRole('button', { name: 'Past conversations' })).not.toHaveClass('lg:hidden')
    })

    it('in floating full screen shows the sidebar', async () => {
      await openPanel()
      act(() => {
        useAssistantUiStore.setState({ mode: 'fullscreen' })
      })
      expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'New chat' })).toHaveClass('lg:hidden')
    })

    it('limits the conversation to a reading column on /chat', () => {
      renderChatPage()
      expect(screen.getByText('How can I help?').closest('.max-w-3xl')).toHaveClass('mx-auto', 'w-full')
    })

    it('uses the full card width for the conversation in the bubble', async () => {
      await openPanel()
      expect(screen.getByText('How can I help?').closest('.max-w-3xl')).toBeNull()
    })
  })

  it('on /chat is never modal or trapped, even when the stored mode is full screen', () => {
    useAssistantUiStore.setState({ mode: 'fullscreen' })
    renderChatPage()
    expect(screen.getByRole('region', { name: 'Assistant' })).not.toHaveAttribute('aria-modal')
  })

  describe('error line', () => {
    it('shows a run error as an alert with the message', async () => {
      scripts.push([
        { type: EventType.RUN_STARTED, threadId: 't', runId: 'r1' },
        { type: EventType.RUN_ERROR, message: 'boom' },
      ])
      const user = await openPanel()
      await user.type(composer(), 'Hi')
      await user.keyboard('{Enter}')
      expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong: boom')
    })

    it('shows no alert for a successful answer', async () => {
      const user = await openPanel()
      await send(user, 'Hi', 'Hello there.')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('exports the conversation with translated speaker labels', async () => {
    const user = await openPanel()
    await send(user, 'What is up?', 'Not much.')
    await user.click(screen.getByRole('button', { name: 'Export conversation (Markdown)' }))
    expect(downloadMarkdown).toHaveBeenCalledExactlyOnceWith(
      'assistant-conversation.md',
      expect.stringContaining('## You\n\nWhat is up?\n\n## Assistant\n\nNot much.'),
    )
  })

  it('after a reload loads the conversation that was last in view', () => {
    useAssistantUiStore.setState({ activeThreadId: 'saved-1' })
    renderChatPage()
    expect(getSession).toHaveBeenCalledExactlyOnceWith('saved-1')
  })

  describe('New chat', () => {
    it('closes the sessions drawer', async () => {
      const user = await openPanel()
      await send(user, 'First question', 'First answer.')
      await user.click(screen.getByRole('button', { name: 'Past conversations' }))
      expect(drawer()).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'New chat' }))
      expect(drawer()).not.toBeInTheDocument()
    })

    it('starts with an empty composer, not the earlier suggestion', async () => {
      const user = await openPanel()
      await sendSuggestion(user)
      await user.click(screen.getByRole('button', { name: 'New chat' }))
      expect(screen.queryByText('Suggestion answered.')).not.toBeInTheDocument()
      expect(composer()).toHaveValue('')
    })
  })

  describe('picking a conversation', () => {
    it('closes the sessions drawer', async () => {
      const user = await openPanel()
      await send(user, 'First question', 'First answer.')
      await user.click(screen.getByRole('button', { name: 'New chat' }))
      await pickFromDrawer(user, 'First question')
      expect(drawer()).not.toBeInTheDocument()
      expect(screen.getByText('First answer.')).toBeInTheDocument()
    })

    it('shows it with an empty composer, not the suggestion picked elsewhere', async () => {
      const user = await openPanel()
      await send(user, 'First question', 'First answer.')
      await user.click(screen.getByRole('button', { name: 'New chat' }))
      await sendSuggestion(user)
      await pickFromDrawer(user, 'First question')
      expect(screen.getByText('First answer.')).toBeInTheDocument()
      expect(composer()).toHaveValue('')
    })
  })
})
