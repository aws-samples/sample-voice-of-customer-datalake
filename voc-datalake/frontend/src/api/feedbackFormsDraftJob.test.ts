/**
 * The AI draft's job loop (feedbackFormsDraftJob.ts): a read every 1.5 s without push; with push, woken at once by the
 * job's notice (the settings assist worker's, lambda/shared/assist_jobs.py) and slowed to the 10 s fallback
 * otherwise; Stop drafting (`signal`) ends it; the refusals keep their statuses; three minutes is a 504.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settleDraft } from './feedbackFormsDraftJob'
import type { DraftRefusal } from './feedbackFormsDraftJob'
import { ASSIST_SUBSCRIBED_POLL_INTERVAL_MS } from './assistJobs'
import { deliverNotice, setRealtimeLive } from '../realtime/hub'

const STARTED = { success: true, job_id: 'job_1', status: 'pending' }
const RUNNING = { success: true, status: 'running' }
const DRAFT = { success: true, form: { name: 'NPS' }, notes: [], warnings: [] }
const COMPLETED = { success: true, status: 'completed', result: DRAFT }

class Refusal extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly errors: readonly unknown[]

  constructor(status: number, code: string | undefined, message: string | undefined, errors: readonly unknown[]) {
    super(message ?? '')
    this.status = status
    this.code = code
    this.errors = errors
  }
}
const refuse: DraftRefusal = (status, code, message, errors) => new Refusal(status, code, message, errors)

/** A poll answering `answers` in turn, then the last one for ever. */
function pollAnswers(...answers: unknown[]) {
  const poll = vi.fn<(jobId: string) => Promise<unknown>>()
  for (const answer of answers.slice(0, -1)) poll.mockResolvedValueOnce(answer)
  return poll.mockResolvedValue(answers.at(-1))
}

/** What `promise` settles to (its error, when it rejects), caught at once so fake time can run. */
function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then((value) => value, (error: unknown) => error)
}

/** A refusal as [status, code, message, errors]. */
function refusal(error: unknown): unknown[] {
  return error instanceof Refusal ? [error.status, error.code, error.message, error.errors] : [error]
}

beforeEach(() => {
  vi.useFakeTimers()
  setRealtimeLive(false)
})
afterEach(() => {
  setRealtimeLive(false)
  vi.useRealTimers()
})

describe('settleDraft', () => {
  it('answers a draft the server answered at once, and reads nothing', async () => {
    const poll = pollAnswers(COMPLETED)

    await expect(settleDraft(DRAFT, poll, refuse)).resolves.toBe(DRAFT)
    expect(poll).not.toHaveBeenCalled()
  })

  it('reads the job every 1.5 s without push until it ends', async () => {
    const poll = pollAnswers(RUNNING, RUNNING, COMPLETED)
    const settled = outcome(settleDraft(STARTED, poll, refuse))

    await vi.advanceTimersByTimeAsync(1499)
    expect(poll).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)

    await expect(settled).resolves.toBe(DRAFT)
    expect(poll.mock.calls).toStrictEqual([['job_1'], ['job_1'], ['job_1']])
  })

  it("is woken at once by the job's notice while push is live, and ignores another job's", async () => {
    setRealtimeLive(true)
    const poll = pollAnswers(COMPLETED)
    const settled = outcome(settleDraft(STARTED, poll, refuse))
    await vi.advanceTimersByTimeAsync(0)

    deliverNotice({ type: 'job', job_id: 'job_2', status: 'completed' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(poll).toHaveBeenCalledTimes(0)
    deliverNotice({ type: 'job', job_id: 'job_1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)

    await expect(settled).resolves.toBe(DRAFT)
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('falls back to a read every 10 s while push is live and no notice comes', async () => {
    setRealtimeLive(true)
    const poll = pollAnswers(RUNNING, COMPLETED)
    const settled = outcome(settleDraft(STARTED, poll, refuse))

    await vi.advanceTimersByTimeAsync(ASSIST_SUBSCRIBED_POLL_INTERVAL_MS - 1)
    expect(poll).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(ASSIST_SUBSCRIBED_POLL_INTERVAL_MS)

    await expect(settled).resolves.toBe(DRAFT)
  })

  it('stops reading once the draft is stopped, with an AbortError, and hears no notice after', async () => {
    const poll = pollAnswers(RUNNING)
    const stop = new AbortController()
    const settled = outcome(settleDraft(STARTED, poll, refuse, stop.signal))
    await vi.advanceTimersByTimeAsync(1500)
    stop.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    deliverNotice({ type: 'job', job_id: 'job_1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)

    const error = await settled
    expect(error instanceof DOMException ? error.name : error).toBe('AbortError')
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('words a failed job as a 500 with its error', async () => {
    const settled = outcome(settleDraft(STARTED, pollAnswers({ status: 'failed', error: 'The model is busy' }), refuse))
    await vi.advanceTimersByTimeAsync(1500)

    expect(refusal(await settled)).toStrictEqual([500, undefined, 'The model is busy', []])
  })

  it.each([
    [{ success: false, code: 'invalid_draft', error: 'Invalid', errors: ['Question 4 has 52 options'] }, [422, 'invalid_draft', 'Invalid', ['Question 4 has 52 options']]],
    [{ success: false, code: 'no_model', error: 'No model' }, [503, 'no_model', 'No model', []]],
    [{ success: false, code: 'something_else' }, [500, 'something_else', '', []]],
    [{ success: false }, [500, undefined, '', []]],
  ])('words the refusal %j with its status', async (result, expected) => {
    const settled = outcome(settleDraft(STARTED, pollAnswers({ status: 'completed', result }), refuse))
    await vi.advanceTimersByTimeAsync(1500)

    expect(refusal(await settled)).toStrictEqual(expected)
  })

  it('gives up three minutes after the start, as a 504 timeout, even with the slow fallback', async () => {
    setRealtimeLive(true)
    const poll = pollAnswers(RUNNING)
    const settled = outcome(settleDraft(STARTED, poll, refuse))
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000)

    expect(refusal(await settled)).toStrictEqual([504, 'timeout', '', []])
    expect(poll).toHaveBeenCalledTimes(18)
  })
})
