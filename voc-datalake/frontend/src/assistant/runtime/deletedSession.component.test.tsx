/**
 * Live 5.16 finding (verify11): after a conversation was deleted, every later
 * page load (/ and /account) still asked for it — `GET /chat/conversations/{id}`
 * answered 404 and the id was never forgotten, because the real sessions client
 * threw on 404 while the restore treated a throw as "temporarily unavailable,
 * keep the id for the next load".
 *
 * These specs run the REAL sessions client, stores and restore against a fake
 * conversations route (404 for an id it does not hold, like chat_handler), with
 * the remembered id round-tripping through localStorage like a reload:
 *  - deleting a conversation leaves no remembered id, so the next load never asks for it;
 *  - the other open conversations stay open, and the one now in view is what a reload brings back;
 *  - a stale remembered id costs exactly one 404, handled silently, then it is gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { rowAction } from '@test/assistantRowMenu'

const server = await vi.hoisted(async () => {
  const { ApiError } = await import('../../lib/errors')
  const sessions = new Map<string, Record<string, unknown>>()
  const calls: string[] = []
  const PREFIX = '/chat/conversations/'
  function list() {
    return { conversations: [...sessions.values()].map(({ messages: _m, ...rest }) => ({ ...rest, messageCount: 2 })) }
  }
  function answer(path: string, method: string): unknown {
    if (path.startsWith(`${PREFIX}_list`)) return list()
    const id = decodeURIComponent(path.slice(PREFIX.length))
    if (method === 'DELETE') {
      // Like chat_handler: deleting is idempotent, a missing conversation is still a success.
      sessions.delete(id)
      return { success: true }
    }
    const record = sessions.get(id)
    if (record === undefined) throw new ApiError(404, 'Conversation not found')
    return record
  }
  const fetchApi = (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${path}`)
    try {
      return Promise.resolve(answer(path, method))
    } catch (error) {
      return Promise.reject(error)
    }
  }
  return { sessions, calls, fetchApi }
})
vi.mock('../../api/client', () => ({ fetchApi: server.fetchApi }))
vi.mock('../agui/client', async (importOriginal) => ({ ...(await importOriginal<object>()), runAgent: vi.fn() }))

import SessionList from '../components/SessionList'
import { useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { openSession } from './runtime'
import { useRestoreLastSession } from './restoreSession'
import type { RunEnvironment } from './runtime'

const ENV: RunEnvironment = { page: { kind: 'dashboard', path: '/dashboard' }, useWebSearch: false }
const ALPHA = 'conv-alpha'
const BETA = 'conv-beta'
const GONE = 'conv-deleted-elsewhere'

function store(id: string, question: string): void {
  server.sessions.set(id, {
    id, title: question, kind: 'assistant',
    messages: [{ id: `${id}-u`, role: 'user', content: question }, { id: `${id}-a`, role: 'assistant', content: `Answer to ${question}` }],
    page: null, pendingInterrupts: [], createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:01:00.000Z', runStatus: 'finished', revision: 1,
  })
}

/** GETs of one conversation (not the list, not saves or deletes). */
function readsOf(id: string): string[] {
  return server.calls.filter((call) => call === `GET /chat/conversations/${id}`)
}

/** A full page load: memory is gone, the UI store comes back from localStorage, the app shell restores. */
async function reload(): Promise<void> {
  act(() => {
    useThreadStore.getState().reset()
  })
  await act(async () => {
    await useAssistantUiStore.persist.rehydrate()
  })
  const hook = renderHook(() => {
    useRestoreLastSession(ENV)
  })
  await waitFor(() => {
    expect(useThreadStore.getState().restore.status).toBe('done')
  })
  hook.unmount()
}

/** Open each conversation in turn (the last one ends up in view), like picking them from the history. */
async function openAll(...ids: string[]): Promise<void> {
  await act(async () => {
    for (const id of ids) await openSession(id, ENV)
  })
}

/** Delete Beta the way a person does: its row menu, then the confirm. */
async function deleteBetaFromList(): Promise<void> {
  render(<SessionList onPick={vi.fn()} />)
  const user = userEvent.setup()
  await rowAction(user, 'Beta question', 'Delete')
  await user.click(screen.getByRole('button', { name: 'Delete conversation' }))
  await waitFor(() => {
    expect(useThreadStore.getState().order).not.toContain(BETA)
  })
}

/** Alpha and Beta open (Beta in view), then Beta deleted from the conversation list. */
async function openBothAndDeleteBeta(): Promise<void> {
  await openAll(ALPHA, BETA)
  await deleteBetaFromList()
}

/**
 * A working localStorage for this file (the global setup stubs it as a no-op), so the
 * remembered id really round-trips through storage across a "reload".
 */
function backLocalStorageWithMemory(): void {
  const stored = new Map<string, string>()
  vi.mocked(localStorage.getItem).mockImplementation((key) => stored.get(key) ?? null)
  vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
    stored.set(key, value)
  })
  vi.mocked(localStorage.removeItem).mockImplementation((key) => {
    stored.delete(key)
  })
}

/** A clean slate: empty fake route log, nothing in localStorage or memory. */
function resetAll(): void {
  server.sessions.clear()
  server.calls.length = 0
  backLocalStorageWithMemory()
  useAssistantUiStore.getState().reset()
  useThreadStore.getState().reset()
}

describe('a deleted conversation is never asked for again', () => {
  beforeEach(() => {
    resetAll()
    store(ALPHA, 'Alpha question')
    store(BETA, 'Beta question')
  })

  it('keeps the other open conversation and remembers it, not the deleted one', async () => {
    await openBothAndDeleteBeta()
    const { order, activeId } = useThreadStore.getState()
    expect(order).toContain(ALPHA)
    expect(order).not.toContain(BETA)
    expect(activeId).toBe(ALPHA)
    expect(useAssistantUiStore.getState().activeThreadId).toBe(ALPHA)
  })

  it('delete then reload brings back the remaining conversation and never requests the deleted one', async () => {
    await openBothAndDeleteBeta()
    server.calls.length = 0
    await reload()
    expect(readsOf(BETA)).toStrictEqual([])
    expect(readsOf(ALPHA)).toHaveLength(1)
    expect(useThreadStore.getState().activeId).toBe(ALPHA)
  })

  it('deleting the only conversation leaves nothing to restore: the next load makes no request at all', async () => {
    await openAll(BETA)
    await deleteBetaFromList()
    expect(useAssistantUiStore.getState().activeThreadId).toBeNull()
    server.calls.length = 0
    await reload()
    expect(server.calls).toStrictEqual([])
  })
})

describe('a stale remembered id (deleted in another tab or browser)', () => {
  beforeEach(() => {
    resetAll()
    // What an earlier page load left behind in localStorage.
    useAssistantUiStore.getState().setActiveThreadId(GONE)
  })

  afterEach(() => {
    // Only the console spy below is a spyOn; the setup's storage stubs are vi.fn and stay.
    vi.restoreAllMocks()
  })

  it('costs one 404, handled without a console error, and opens a fresh empty conversation', async () => {
    const consoleError = vi.spyOn(console, 'error')
    await reload()
    expect(readsOf(GONE)).toHaveLength(1)
    expect(consoleError).not.toHaveBeenCalled()
    expect(useAssistantUiStore.getState().activeThreadId).toBeNull()
    expect(useThreadStore.getState().thread.messages).toStrictEqual([])
  })

  it('is forgotten: the next page loads never ask for it again (no retry)', async () => {
    await reload()
    await reload()
    await reload()
    expect(readsOf(GONE)).toHaveLength(1)
  })

  it('a malformed stored id is dropped on load without any request', async () => {
    act(() => {
      useAssistantUiStore.getState().setActiveThreadId('../not a session id')
    })
    await reload()
    expect(server.calls).toStrictEqual([])
    expect(useAssistantUiStore.getState().activeThreadId).toBeNull()
  })
})
