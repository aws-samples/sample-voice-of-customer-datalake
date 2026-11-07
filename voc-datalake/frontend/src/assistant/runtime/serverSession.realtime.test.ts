/**
 * A reloaded session the server is still generating, with push (docs/realtime.md): the stream Lambda's
 * `session` notice re-reads it at once; while subscribed the GET poll slows to the fallback interval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../sessions/sessionsApi', () => import('./runtime-fixtures').then((m) => m.sessionsApiModule()))

import { openSession } from './runtime'
import { HOME_ENV, runningSession } from './runtime-fixtures'
import { SUBSCRIBED_FOLLOW_DELAY_MS } from './followServerRun'
import { getSession } from '../sessions/sessionsApi'
import { slotOf, useThreadStore } from '../store/assistantStore'
import { deliverNotice, setRealtimeLive } from '../../realtime/hub'

const env = HOME_ENV
const getSessionMock = vi.mocked(getSession)

const record = runningSession

const finished = () => record({ runStatus: 'finished', revision: 12 })
const status = () => slotOf(useThreadStore.getState().slots, 'conv_1')?.thread.status

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-10-06T12:00:00Z'))
  setRealtimeLive(false)
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
