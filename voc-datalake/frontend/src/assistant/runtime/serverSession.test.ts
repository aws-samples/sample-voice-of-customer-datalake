/**
 * Server-side session persistence, as the SPA sees it (QA s1 F3, perf §4):
 * - a session the server is still generating opens `generating` with the
 *   partial answer, polls with backoff and stops when the stored run ends;
 * - the SPA's saves carry the newest server revision it saw, and a 409 (the
 *   server owns a newer revision) makes it adopt the server's copy instead of
 *   overwriting it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventType } from '@ag-ui/core'
import type { SessionRecord } from '../sessions/schema'

vi.mock('../sessions/sessionsApi', () => ({ getSession: vi.fn(), saveSession: vi.fn() }))
vi.mock('../agui/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agui/client')>(),
  runAgent: vi.fn(),
}))

import { runAgent } from '../agui/client'
import { openSession, sendMessage, stopRun } from './runtime'
import { FOLLOW_BOUND_MS, FOLLOW_TIMEOUT_CODE } from './followServerRun'
import { getSession, saveSession } from '../sessions/sessionsApi'
import { normalizeSessionRecord } from '../sessions/schema'
import { slotOf, useThreadStore } from '../store/assistantStore'
import { ApiError } from '../../lib/errors'
import type { RunEnvironment } from './runtime'

const env: RunEnvironment = { page: { kind: 'home', path: '/' }, useWebSearch: false }
const NOW = Date.parse('2026-10-06T12:00:00Z')

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'conv_1', title: 'Q', kind: 'assistant',
    messages: [{ id: 'u1', role: 'user', content: 'Why?' }, { id: 'a1', role: 'assistant', content: 'Because' }],
    page: null, pendingInterrupts: [], createdAt: '2026-10-06T11:59:00.000Z',
    updatedAt: new Date(Date.now()).toISOString(), runStatus: 'running', revision: 10,
    ...overrides,
  }
}

const runAgentMock = vi.mocked(runAgent)
const getSessionMock = vi.mocked(getSession)
const saveSessionMock = vi.mocked(saveSession)

function slot(id = 'conv_1') {
  return slotOf(useThreadStore.getState().slots, id)
}

describe('a session the server is still generating', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    useThreadStore.getState().reset()
    getSessionMock.mockReset()
    saveSessionMock.mockReset()
    saveSessionMock.mockResolvedValue(undefined)
    runAgentMock.mockReset()
  })
  afterEach(async () => {
    // Close every thread so a follower still polling sees it gone and ends.
    useThreadStore.getState().reset()
    await vi.runAllTimersAsync()
    vi.useRealTimers()
  })

  /** Open a session that is running, grows once, then finishes. */
  async function openGrowingThenFinished() {
    const user = record().messages.slice(0, 1)
    getSessionMock
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(record({ messages: [...user, { id: 'a1', role: 'assistant', content: 'Because of pricing' }], revision: 11 }))
      .mockResolvedValueOnce(record({
        messages: [...user, { id: 'a1', role: 'assistant', content: 'Because of pricing, mostly.' }],
        runStatus: 'finished', revision: 12,
      }))
    await openSession('conv_1', env)
  }

  it('opens a running session as generating, with the partial answer', async () => {
    await openGrowingThenFinished()
    expect(slot()?.thread.status).toBe('generating')
    expect(slot()?.thread.messages.at(-1)).toMatchObject({ content: 'Because' })
  })

  it('shows the answer growing while it polls', async () => {
    await openGrowingThenFinished()
    await vi.advanceTimersByTimeAsync(1000)
    expect(slot()?.thread.status).toBe('generating')
    expect(slot()?.thread.messages.at(-1)).toMatchObject({ content: 'Because of pricing' })
  })

  it('renders the final answer once the stored run finished, and stops polling', async () => {
    await openGrowingThenFinished()
    await vi.advanceTimersByTimeAsync(1000 + 2000)
    expect(slot()?.thread).toMatchObject({ status: 'idle', messages: [{ id: 'u1' }, { content: 'Because of pricing, mostly.' }] })
    expect(slot()?.revision).toBe(12)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getSessionMock).toHaveBeenCalledTimes(3)
  })

  it('backs off between polls (1 s, 2 s, 3 s, then every 5 s)', async () => {
    getSessionMock.mockImplementation(async () => record({ updatedAt: new Date(Date.now()).toISOString() }))
    await openSession('conv_1', env)
    const counts: number[] = []
    for (const step of [999, 1, 2000, 3000, 5000, 5000]) {
      await vi.advanceTimersByTimeAsync(step)
      counts.push(getSessionMock.mock.calls.length)
    }
    expect(counts).toStrictEqual([1, 2, 3, 4, 5, 6])
  })

  it('gives up after the bound and says so', async () => {
    getSessionMock.mockImplementation(async () => record({ updatedAt: new Date(Date.now()).toISOString() }))
    await openSession('conv_1', env)
    await vi.advanceTimersByTimeAsync(FOLLOW_BOUND_MS + 10_000)
    expect(slot()?.thread).toMatchObject({ status: 'error', error: { code: FOLLOW_TIMEOUT_CODE } })
    const polls = getSessionMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getSessionMock.mock.calls.length).toBe(polls)
  })

  it('keeps polling through a failed poll', async () => {
    getSessionMock
      .mockResolvedValueOnce(record())
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(record({ runStatus: 'finished', revision: 12 }))
    await openSession('conv_1', env)
    await vi.advanceTimersByTimeAsync(1000 + 2000)
    expect(getSessionMock).toHaveBeenCalledTimes(3)
    expect(slot()?.revision).toBe(12)
  })

  it('treats a dead running record (no write for STALE_RUN_SECONDS) as finished: no polling', async () => {
    getSessionMock.mockResolvedValueOnce(record({ updatedAt: new Date(NOW - 400_000).toISOString() }))
    await openSession('conv_1', env)
    expect(slot()?.thread.status).toBe('idle')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getSessionMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a new message while the server is still answering', async () => {
    getSessionMock.mockResolvedValue(record())
    await openSession('conv_1', env)
    await sendMessage('another', env, 'conv_1')
    expect(runAgentMock).not.toHaveBeenCalled()
  })

  it('stops polling when the conversation is closed', async () => {
    getSessionMock.mockResolvedValue(record())
    await openSession('conv_1', env)
    useThreadStore.getState().close('conv_1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getSessionMock).toHaveBeenCalledTimes(1)
  })

  it('reads runStatus and revision from the wire record (and defaults them)', () => {
    expect(normalizeSessionRecord({ id: 'c', runStatus: 'running', revision: 5, updatedAt: 'u' }))
      .toMatchObject({ runStatus: 'running', revision: 5 })
    expect(normalizeSessionRecord({ id: 'c', runStatus: 'bogus', revision: -1 }))
      .toMatchObject({ runStatus: null, revision: 0 })
  })
})

describe('the SPA never overwrites a newer server revision', () => {
  beforeEach(() => {
    vi.useRealTimers()
    useThreadStore.getState().reset()
    getSessionMock.mockReset()
    saveSessionMock.mockReset()
    saveSessionMock.mockResolvedValue(undefined)
    runAgentMock.mockReset()
  })

  function finishedRunWithRevision(revision: number) {
    runAgentMock.mockImplementationOnce(async (input, onEvent) => {
      // A real stream answers after the request goes out: the save made as the run starts lands first.
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
      onEvent({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId })
      onEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Done' })
      onEvent({ type: EventType.CUSTOM, name: 'assistant.session', value: { revision } })
      onEvent({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId })
    })
  }

  it('sends the server revision it was told as baseRevision', async () => {
    finishedRunWithRevision(42)
    await sendMessage('hi', env)
    await vi.waitFor(() => expect(saveSessionMock).toHaveBeenCalledTimes(2))
    expect(saveSessionMock.mock.calls.at(0)?.[0].baseRevision).toBe(0)
    expect(saveSessionMock.mock.calls.at(-1)?.[0].baseRevision).toBe(42)
  })

  it('on 409 adopts the server copy (and follows it while it is still running) instead of overwriting', async () => {
    // A stream cut mid-answer: the client has a partial, the server is still writing.
    runAgentMock.mockImplementationOnce(async (input, onEvent) => {
      onEvent({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId })
      onEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Part' })
      throw new Error('network')
    })
    saveSessionMock.mockRejectedValue(new ApiError(409))
    const threadId = useThreadStore.getState().activeId
    getSessionMock.mockResolvedValue(record({
      id: threadId, runStatus: 'finished', revision: 50,
      messages: [{ id: 'u', role: 'user', content: 'hi' }, { id: 'a', role: 'assistant', content: 'Partial, then complete.' }],
    }))

    await sendMessage('hi', env)

    await vi.waitFor(() => expect(slot(threadId)?.thread.messages.at(-1)).toMatchObject({ content: 'Partial, then complete.' }))
    expect(slot(threadId)?.revision).toBe(50)
  })

  it('does not adopt an older server copy', async () => {
    finishedRunWithRevision(60)
    saveSessionMock.mockRejectedValue(new ApiError(409))
    const threadId = useThreadStore.getState().activeId
    getSessionMock.mockResolvedValue(record({ id: threadId, runStatus: 'finished', revision: 59, messages: [] }))
    await sendMessage('hi', env)
    await vi.waitFor(() => expect(getSessionMock).toHaveBeenCalledWith(threadId))
    expect(slot(threadId)?.thread.messages.at(-1)).toMatchObject({ content: 'Done' })
  })

  it('stop keeps what the user saw even when the server refuses the save', async () => {
    // A run that streams one delta and then waits until it is aborted.
    runAgentMock.mockImplementationOnce(async (input, onEvent, signal) => {
      const aborted = new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
      for (const event of [
        { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Seen so far' },
      ] as const) onEvent(event)
      await aborted
    })
    // The save as the run starts lands; the one after Stop is refused (the server run is live).
    saveSessionMock.mockResolvedValueOnce(undefined).mockRejectedValue(new ApiError(409))
    getSessionMock.mockResolvedValue(record({ revision: 99 }))
    const threadId = useThreadStore.getState().activeId
    const run = sendMessage('hi', env, threadId)
    await vi.waitFor(() => expect(slot(threadId)?.thread.status).toBe('streaming'))
    stopRun(env.page, threadId)
    await run
    await vi.waitFor(() => expect(saveSessionMock).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(slot(threadId)?.thread).toMatchObject({ status: 'idle' })
  })
})
