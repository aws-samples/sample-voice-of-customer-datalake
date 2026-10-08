/**
 * SessionList / SessionsDrawer: open conversations (status, order, close) and
 * the saved history (loading, error, empty, delete, refetch on save), with the
 * sessions API mocked and the thread store seeded directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { useQuery } from '@tanstack/react-query'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import type { Message } from '@ag-ui/core'

vi.mock('../sessions/sessionsApi', async () => (await import('@test/assistantDoubles')).sessionsApiModule())

import SessionList from './SessionList'
import SessionsDrawer from './SessionsDrawer'
import { deleteSession, listSessions } from '../sessions/sessionsApi'
import { slotOf, useThreadStore } from '../store/assistantStore'
import { createThreadState } from '../thread/reducer'
import type { SessionSummary } from '../sessions/schema'
import type { ThreadState } from '../thread/types'

const STATUS_LABELS = /^(Running|Waiting for your approval|Failed|New reply)$/

function userMessage(id: string, content: string): Message {
  return { id, role: 'user', content }
}

/** Open a conversation (it comes into view) whose title is its first user message. */
function openThread(id: string, title: string, patch: Partial<ThreadState> = {}): void {
  act(() => {
    useThreadStore.getState().replace({ ...createThreadState(id), messages: [userMessage(`${id}-u`, title)], ...patch })
  })
}

function markUnread(id: string): void {
  act(() => {
    useThreadStore.setState((s) => {
      const slot = slotOf(s.slots, id)
      return slot === undefined ? {} : { slots: { ...s.slots, [id]: { ...slot, unread: true } } }
    })
  })
}

function summary(id: string, title: string, updatedAt = ''): SessionSummary {
  return { id, title, kind: 'assistant', messageCount: 2, createdAt: '', updatedAt }
}

/** The saved sessions the mocked list returns. */
function serveHistory(...sessions: SessionSummary[]): void {
  vi.mocked(listSessions).mockImplementation(() => Promise.resolve(sessions))
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('li')
  if (row === null) throw new Error(`no row for ${text}`)
  return row
}

function pickButtonOf(text: string): HTMLElement {
  const button = screen.getByText(text).closest('button')
  if (button === null) throw new Error(`no pick button for ${text}`)
  return button
}

function openList(): HTMLElement {
  return screen.getByRole('list', { name: 'Open' })
}

const probeFn = vi.fn(() => Promise.resolve('probe'))

/** Another query on the same client: it must not be refetched by the list's invalidations. */
function Probe() {
  const { data } = useQuery({ queryKey: ['probe'], queryFn: probeFn })
  return <span>{data}</span>
}

function renderList(onPick = vi.fn()) {
  render(<><SessionList onPick={onPick} /><Probe /></>)
  return onPick
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listSessions).mockImplementation(() => Promise.resolve([]))
  vi.mocked(deleteSession).mockImplementation(() => Promise.resolve())
  useThreadStore.getState().reset()
})

describe('SessionList open conversations', () => {
  it('lists open conversations newest first and hides the untouched empty one', () => {
    openThread('thread-a', 'Alpha')
    openThread('thread-b', 'Beta')
    renderList()
    const titles = within(openList()).getAllByRole('listitem').map((li) => li.textContent)
    expect(titles).toStrictEqual(['Beta', 'Alpha'])
  })

  it('shows no Open group when every open conversation is empty', () => {
    renderList()
    expect(screen.queryByRole('heading', { name: 'Open' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Open' })).not.toBeInTheDocument()
  })

  it('renders its group headings at the level the host asks for (E2E F9)', () => {
    openThread('thread-a', 'Alpha')
    render(<SessionList onPick={vi.fn()} groupHeadingLevel={3} />)
    expect(screen.getByRole('heading', { level: 3, name: 'Open' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'History' })).toBeInTheDocument()
  })

  it('headings name both groups', async () => {
    openThread('thread-a', 'Alpha')
    renderList()
    expect(screen.getByRole('heading', { level: 4, name: 'Open' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 4, name: 'History' })).toBeInTheDocument()
  })

  it('skips an id in the order that has no slot', () => {
    openThread('thread-a', 'Alpha')
    act(() => { useThreadStore.setState((s) => ({ order: ['ghost', ...s.order] })) })
    renderList()
    expect(within(openList()).getAllByRole('listitem')).toHaveLength(1)
  })

  it('marks only the conversation in view as current', () => {
    openThread('thread-a', 'Alpha')
    openThread('thread-b', 'Beta')
    renderList()
    expect(pickButtonOf('Beta')).toHaveAttribute('aria-current', 'true')
    expect(pickButtonOf('Alpha')).not.toHaveAttribute('aria-current')
    expect(rowOf('Beta')).toHaveClass('nav-active')
    expect(rowOf('Alpha')).not.toHaveClass('nav-active')
  })

  it('picking an open conversation passes its thread id', async () => {
    openThread('thread-a', 'Alpha')
    openThread('thread-b', 'Beta')
    const onPick = renderList()
    await userEvent.click(screen.getByText('Alpha'))
    expect(onPick).toHaveBeenCalledExactlyOnceWith('thread-a')
  })

  it('titles a conversation without a user message "New conversation"', () => {
    act(() => {
      useThreadStore.getState().replace({ ...createThreadState('thread-x'), messages: [{ id: 'a1', role: 'assistant', content: 'hi' }] })
    })
    renderList()
    expect(screen.getByRole('button', { name: 'Close “New conversation”' })).toBeInTheDocument()
  })

  it('an idle conversation shows a plain icon, no status and a normal-weight title', () => {
    openThread('thread-a', 'Alpha')
    renderList()
    expect(within(rowOf('Alpha')).queryByLabelText(STATUS_LABELS)).not.toBeInTheDocument()
    expect(pickButtonOf('Alpha').querySelector('svg')).not.toBeNull()
    expect(screen.getByText('Alpha')).not.toHaveClass('font-semibold')
  })

  it('an idle conversation offers a plain close', () => {
    openThread('thread-a', 'Alpha')
    renderList()
    expect(screen.getByRole('button', { name: 'Close “Alpha”' })).toHaveAttribute('title', 'Close “Alpha”')
  })

  it('a running conversation shows Running and offers stop-and-close', () => {
    openThread('thread-a', 'Alpha', { status: 'streaming' })
    renderList()
    expect(within(rowOf('Alpha')).getByLabelText('Running')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop and close “Alpha”' })).toBeInTheDocument()
  })

  it('a conversation awaiting approval says so', () => {
    openThread('thread-a', 'Alpha', { status: 'awaiting_approval' })
    renderList()
    expect(within(rowOf('Alpha')).getByLabelText('Waiting for your approval')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close “Alpha”' })).toBeInTheDocument()
  })

  it('a failed conversation shows Failed', () => {
    openThread('thread-a', 'Alpha', { status: 'error' })
    renderList()
    expect(within(rowOf('Alpha')).getByLabelText('Failed')).toBeInTheDocument()
  })

  it('an unread conversation shows New reply and a bold title', () => {
    openThread('thread-a', 'Alpha')
    openThread('thread-b', 'Beta')
    markUnread('thread-a')
    renderList()
    expect(within(rowOf('Alpha')).getByLabelText('New reply')).toBeInTheDocument()
    expect(screen.getByText('Alpha')).toHaveClass('font-semibold')
  })

  it('the close button drops the conversation from the Open group', async () => {
    openThread('thread-a', 'Alpha')
    openThread('thread-b', 'Beta')
    renderList()
    await userEvent.click(screen.getByRole('button', { name: 'Close “Alpha”' }))
    expect(within(openList()).getAllByRole('listitem').map((li) => li.textContent)).toStrictEqual(['Beta'])
  })
})

describe('SessionList history', () => {
  it('shows a loader and no empty message while loading', () => {
    vi.mocked(listSessions).mockImplementation(() => new Promise<SessionSummary[]>(() => undefined))
    renderList()
    expect(screen.getByLabelText('Loading conversations')).toBeInTheDocument()
    expect(screen.queryByText('No saved conversations yet.')).not.toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'History' })).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('says there is nothing saved once an empty list loads', async () => {
    renderList()
    expect(await screen.findByText('No saved conversations yet.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading conversations')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports a failed load', async () => {
    vi.mocked(listSessions).mockImplementation(() => Promise.reject(new Error('boom')))
    renderList()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load conversations.')
  })

  it('lists saved sessions with their date and no empty message', async () => {
    const updatedAt = '2026-01-02T03:04:05.000Z'
    serveHistory(summary('s-beta', 'Beta', updatedAt))
    renderList()
    expect(await screen.findByText(new Date(updatedAt).toLocaleString())).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'History' })).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByText('No saved conversations yet.')).not.toBeInTheDocument()
    expect(rowOf('Beta')).not.toHaveClass('nav-active')
  })

  it('an untitled session without a date shows only the fallback title', async () => {
    serveHistory(summary('s-x', ''))
    renderList()
    expect(await screen.findByText('Untitled conversation')).toBeInTheDocument()
    expect(rowOf('Untitled conversation')).toHaveTextContent(/^Untitled conversation$/)
  })

  it('a titled session shows its own title', async () => {
    serveHistory(summary('s-beta', 'Beta'))
    renderList()
    expect(await screen.findByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Untitled conversation')).not.toBeInTheDocument()
  })

  it('leaves out sessions that are already open', async () => {
    openThread('s-alpha', 'Alpha')
    serveHistory(summary('s-alpha', 'Alpha'), summary('s-beta', 'Beta'))
    renderList()
    const history = screen.getByRole('list', { name: 'History' })
    expect(await within(history).findByText('Beta')).toBeInTheDocument()
    expect(within(history).queryByText('Alpha')).not.toBeInTheDocument()
  })

  it('says nothing is saved when every saved session is open', async () => {
    openThread('s-alpha', 'Alpha')
    serveHistory(summary('s-alpha', 'Alpha'))
    renderList()
    expect(await screen.findByText('No saved conversations yet.')).toBeInTheDocument()
  })

  it('picking a saved session passes its id', async () => {
    serveHistory(summary('s-beta', 'Beta'))
    const onPick = renderList()
    await userEvent.click(await screen.findByText('Beta'))
    expect(onPick).toHaveBeenCalledExactlyOnceWith('s-beta')
  })

  it('the delete button deletes that session and refetches only the list', async () => {
    serveHistory(summary('s-beta', 'Beta'))
    renderList()
    const remove = await screen.findByRole('button', { name: 'Delete “Beta”' })
    expect(remove).toHaveAttribute('title', 'Delete “Beta”')
    await userEvent.click(remove)
    expect(vi.mocked(deleteSession).mock.calls.map((call) => call[0])).toStrictEqual(['s-beta'])
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2))
    expect(probeFn).toHaveBeenCalledTimes(1)
  })

  it('deleting a session also closes it when it has been opened meanwhile', async () => {
    const gate: { release: () => void } = { release: () => undefined }
    vi.mocked(deleteSession).mockImplementation(() => new Promise<void>((resolve) => { gate.release = resolve }))
    serveHistory(summary('s-beta', 'Beta'))
    renderList()
    await userEvent.click(await screen.findByRole('button', { name: 'Delete “Beta”' }))
    openThread('s-beta', 'Beta')
    expect(screen.getByRole('button', { name: 'Close “Beta”' })).toBeInTheDocument()
    act(() => { gate.release() })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close “Beta”' })).not.toBeInTheDocument())
  })

  it('fetches the list once on mount', async () => {
    renderList()
    await screen.findByText('No saved conversations yet.')
    await waitFor(() => expect(probeFn).toHaveBeenCalledTimes(1))
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('a remount over cached history refetches it once, not twice', async () => {
    const client = createTestQueryClient({ gcTime: 60_000 })
    const first = renderWithQueryClient(<SessionList onPick={vi.fn()} />, client)
    await screen.findByText('No saved conversations yet.')
    first.unmount()
    renderWithQueryClient(<SessionList onPick={vi.fn()} />, client)
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2))
    await act(() => new Promise((resolve) => { setTimeout(resolve, 20) }))
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('refetches only the list after a conversation is saved', async () => {
    renderList()
    await screen.findByText('No saved conversations yet.')
    act(() => { useThreadStore.getState().noteSaved() })
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2))
    expect(probeFn).toHaveBeenCalledTimes(1)
  })
})

describe('SessionsDrawer', () => {
  it('is a labelled drawer with a heading', () => {
    render(<SessionsDrawer onOpen={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('complementary', { name: 'Past conversations' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Past conversations' })).toBeInTheDocument()
  })

  it('its close button calls onClose', async () => {
    const onClose = vi.fn()
    render(<SessionsDrawer onOpen={vi.fn()} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('picking a conversation calls onOpen with its id', async () => {
    serveHistory(summary('s-beta', 'Beta'))
    const onOpen = vi.fn()
    render(<SessionsDrawer onOpen={onOpen} onClose={vi.fn()} />)
    await userEvent.click(await screen.findByText('Beta'))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('s-beta')
  })
})
