/** api/assistJobs.ts with push (docs/realtime.md): the job's notice wakes the loop; polling is the fallback. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverNotice, setRealtimeLive } from '../realtime/hub'
import { ASSIST_POLL_INTERVAL_MS, ASSIST_SUBSCRIBED_POLL_INTERVAL_MS, runAssistJob } from './assistJobs'

const STARTED = { success: true, job_id: 'job_1', status: 'pending' }
const identity = (result: unknown) => result

function pollAnswers(...answers: unknown[]) {
  const poll = vi.fn<(jobId: string) => Promise<unknown>>()
  answers.forEach((answer) => poll.mockResolvedValueOnce(answer))
  poll.mockResolvedValue(answers.at(-1))
  return poll
}

beforeEach(() => {
  vi.useFakeTimers()
  setRealtimeLive(false)
})
afterEach(() => { vi.useRealTimers() })

describe('runAssistJob with push', () => {
  it('polls at once on the job\'s notice instead of waiting', async () => {
    setRealtimeLive(true)
    const poll = pollAnswers({ status: 'running' }, { status: 'completed', result: 'done' })
    const outcome = runAssistJob(() => Promise.resolve(STARTED), poll, identity)
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(1)
    deliverNotice({ type: 'job', job_id: 'job_2', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(1)
    deliverNotice({ type: 'job', job_id: 'job_1', status: 'completed' })
    await expect(outcome).resolves.toBe('done')
  })

  it('keeps a slower fallback poll while subscribed (a lost notice)', async () => {
    setRealtimeLive(true)
    const poll = pollAnswers({ status: 'running' }, { status: 'completed', result: 1 })
    const outcome = runAssistJob(() => Promise.resolve(STARTED), poll, identity)
    await vi.advanceTimersByTimeAsync(ASSIST_POLL_INTERVAL_MS)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(ASSIST_SUBSCRIBED_POLL_INTERVAL_MS)
    await expect(outcome).resolves.toBe(1)
  })

  it('polls at once on a reconnect', async () => {
    const poll = pollAnswers({ status: 'running' }, { status: 'completed', result: 2 })
    const outcome = runAssistJob(() => Promise.resolve(STARTED), poll, identity)
    await vi.advanceTimersByTimeAsync(0)
    setRealtimeLive(true)
    await expect(outcome).resolves.toBe(2)
  })

  it('without push, polls every interval exactly as before', async () => {
    const poll = pollAnswers({ status: 'running' }, { status: 'completed', result: 3 })
    const outcome = runAssistJob(() => Promise.resolve(STARTED), poll, identity)
    await vi.advanceTimersByTimeAsync(ASSIST_POLL_INTERVAL_MS)
    await expect(outcome).resolves.toBe(3)
  })
})
