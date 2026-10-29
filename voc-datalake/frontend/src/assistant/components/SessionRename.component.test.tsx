/**
 * Renaming a conversation from the session list: pencil → inline field,
 * Enter or leaving the field saves, Escape cancels (without closing the
 * drawer), focus returns to the pencil, a 409 says a reply is still running,
 * and an open conversation shows its saved name over its first message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { ApiError } from '../../lib/errors'

vi.mock('../sessions/sessionsApi', async () => (await import('@test/assistantDoubles')).sessionsApiModule())

import SessionList from './SessionList'
import SessionsDrawer from './SessionsDrawer'
import { listSessions, renameSession } from '../sessions/sessionsApi'
import { useThreadStore } from '../store/assistantStore'
import { createThreadState } from '../thread/reducer'
import type { SessionSummary } from '../sessions/schema'
import { rowAction, rowMenuButton } from '@test/assistantRowMenu'

function saved(id: string, title: string, customTitle: string | null = null): SessionSummary {
  return { id, title, customTitle, kind: 'assistant', messageCount: 2, createdAt: '2026-01-01', updatedAt: '2026-01-02' }
}

const store: { sessions: SessionSummary[] } = { sessions: [] }

beforeEach(() => {
  vi.clearAllMocks()
  store.sessions = [saved('c1', 'Why are deliveries late?')]
  vi.mocked(listSessions).mockImplementation(() => Promise.resolve(store.sessions))
  vi.mocked(renameSession).mockImplementation((id, title) => {
    store.sessions = store.sessions.map((s) => (s.id === id ? saved(id, title, title) : s))
    return Promise.resolve(title)
  })
  useThreadStore.getState().reset()
})

const menuButton = () => rowMenuButton('Why are deliveries late?')
const field = () => screen.getByRole('textbox', { name: 'Conversation name' })

async function startRename() {
  const user = userEvent.setup()
  render(<SessionList onPick={vi.fn()} />)
  await rowAction(user, 'Why are deliveries late?', 'Rename')
  return user
}

describe('renaming a saved conversation', () => {
  it('Enter saves the trimmed name, shows it at once and returns focus to the row menu button', async () => {
    const user = await startRename()
    expect(field()).toHaveValue('Why are deliveries late?')
    await user.clear(field())
    await user.type(field(), '  Late   deliveries {Enter}')
    expect(renameSession).toHaveBeenCalledWith('c1', 'Late deliveries')
    expect(await screen.findByText('Late deliveries')).toBeInTheDocument()
    expect(await rowMenuButton('Late deliveries')).toHaveFocus()
  })

  it('Escape cancels without saving and returns focus to the row menu button', async () => {
    const user = await startRename()
    await user.type(field(), ' (edited){Escape}')
    expect(renameSession).not.toHaveBeenCalled()
    expect(screen.getByText('Why are deliveries late?')).toBeInTheDocument()
    expect(await menuButton()).toHaveFocus()
  })

  it('leaving the field saves', async () => {
    const user = await startRename()
    await user.clear(field())
    await user.type(field(), 'Carrier delays')
    await user.tab()
    expect(renameSession).toHaveBeenCalledWith('c1', 'Carrier delays')
  })

  it('an empty or unchanged name sends nothing', async () => {
    const user = await startRename()
    await user.keyboard('{Enter}')
    await rowAction(user, 'Why are deliveries late?', 'Rename')
    await user.clear(field())
    await user.keyboard('{Enter}')
    expect(renameSession).not.toHaveBeenCalled()
  })

  it('a 409 says a reply is still being generated and puts the old name back', async () => {
    vi.mocked(renameSession).mockRejectedValueOnce(new ApiError(409, 'A reply is still being generated'))
    const user = await startRename()
    await user.clear(field())
    await user.type(field(), 'Too soon{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('A reply is still being generated. Rename it when it finishes.')
    await waitFor(() => expect(screen.getByText('Why are deliveries late?')).toBeInTheDocument())
  })

  it('Escape in the field does not close the sessions drawer', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SessionsDrawer onOpen={vi.fn()} onClose={onClose} />)
    await rowAction(user, 'Why are deliveries late?', 'Rename')
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Conversation name' })).not.toBeInTheDocument()
  })
})

describe('an open conversation', () => {
  it('shows its saved name over the first message and can be renamed', async () => {
    store.sessions = [saved('t1', 'Pricing churn', 'Pricing churn')]
    act(() => {
      useThreadStore.getState().replace({ ...createThreadState('t1'), messages: [{ id: 'u1', role: 'user', content: 'Why do users churn?' }] })
    })
    const user = userEvent.setup()
    render(<SessionList onPick={vi.fn()} />)
    const open = screen.getByRole('list', { name: 'Open' })
    await rowAction(user, 'Pricing churn', 'Rename', within(open))
    await user.type(field(), ' Q3{Enter}')
    expect(renameSession).toHaveBeenCalledWith('t1', 'Pricing churn Q3')
  })

  // 5.35 (E2E 5.34): the field opened on the list's cut title, ellipsis included.
  it('opens the rename field on the whole first message, not the cut title', async () => {
    const question = `Which complaint themes grew the most among business travellers over the last ninety days, and why?`
    store.sessions = []
    act(() => {
      useThreadStore.getState().replace({ ...createThreadState('t2'), messages: [{ id: 'u1', role: 'user', content: question }] })
    })
    const user = userEvent.setup()
    render(<SessionList onPick={vi.fn()} />)
    await rowAction(user, question, 'Rename', within(screen.getByRole('list', { name: 'Open' })))
    expect(field()).toHaveValue(question)
  })
})

describe('a saved conversation with a cut auto-title', () => {
  it('opens the rename field without the ellipsis', async () => {
    store.sessions = [saved('c2', 'Which complaint themes grew the most…')]
    const user = userEvent.setup()
    render(<SessionList onPick={vi.fn()} />)
    await rowAction(user, 'Which complaint themes grew the most…', 'Rename')
    expect(field()).toHaveValue('Which complaint themes grew the most')
  })
})
