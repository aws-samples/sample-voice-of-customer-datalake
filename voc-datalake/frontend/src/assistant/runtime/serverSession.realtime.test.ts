/**
 * A reloaded session the server is still generating, with push (docs/realtime.md): the stream Lambda's
 * `session` notice re-reads it at once; while subscribed the GET poll slows to the fallback interval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionRecord } from '../sessions/schema'

vi.mock('../sessions/sessionsApi', () => ({ getSession: vi.fn(), saveSession: vi.fn(), cancelServerRun: vi.fn(() => Promise.resolve()) }))

import { openSession } from './runtime'
import { SUBSCRIBED_FOLLOW_DELAY_MS } from './followServerRun'
import { getSession } from '../sessions/sessionsApi'
import { slotOf, useThreadStore } from '../store/assistantStore'
import { deliverNotice, resetRealtimeHub, setRealtimeLive } from '../../realtime/hub'
import type { RunEnvironment } from './runtime'

const env: RunEnvironment = { page: { kind: 'home', path: '/' }, useWebSearch: false }
const getSessionMock = vi.mocked(getSession)

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'conv_1',
    messages: [{ id: 'u1', role: 'user', content: 'Why?' }, { id: 'a1', role: 'assistant', content: 'Because' }],
    pendingInterrupts: [], createdAt: '2026-10-06T11:59:00.000Z',
    updatedAt: new Date(Date.now()).toISOString(), runStatus: 'running', revision: 10,
    ...overrides,
  }
}

const finished = () => record({ runStatus: 'finished', revision: 12 })
const status = () => slotOf(useThreadStore.getState().slots, 'conv_1')?.thread.status

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-10-06T12:00:00Z'))
  resetRealtimeHub()
  useThreadStore.getState().reset()
  getSessionMock.mockReset()
})
afterEach(async () => {
  useThreadStore.getState().reset()
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})

describe('following a server run with push', () => {
  it('re-reads at once on the conversation\'s session notice', async () => {
    setRealtimeLive(true)
    getSessionMock.mockResolvedValueOnce(record()).mockResolvedValueOnce(finished())
    await openSession('conv_1', env)
    await vi.advanceTimersByTimeAsync(5000)
    deliverNotice({ type: 'session', conversation_id: 'other', run_status: 'finished', revision: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(getSessionMock).toHaveBeenCalledTimes(1)
    deliverNotice({ type: 'session', conversation_id: 'conv_1', run_status: 'finished', revision: 12 })
    await vi.advanceTimersByTimeAsync(0)
    expect(getSessionMock).toHaveBeenCalledTimes(2)
    expect(status()).toBe('idle')
  })

  it('still finds the end on the slower fallback poll when the notice is lost', async () => {
    setRealtimeLive(true)
    getSessionMock.mockResolvedValueOnce(record()).mockResolvedValueOnce(finished())
    await openSession('conv_1', env)
    await vi.advanceTimersByTimeAsync(SUBSCRIBED_FOLLOW_DELAY_MS)
    expect(getSessionMock).toHaveBeenCalledTimes(2)
    expect(status()).toBe('idle')
  })

  it('without push, polls with the usual backoff', async () => {
    getSessionMock.mockResolvedValueOnce(record()).mockResolvedValueOnce(finished())
    await openSession('conv_1', env)
    await vi.advanceTimersByTimeAsync(1000)
    expect(getSessionMock).toHaveBeenCalledTimes(2)
  })
})
