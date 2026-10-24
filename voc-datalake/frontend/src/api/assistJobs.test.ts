import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ASSIST_POLL_INTERVAL_MS, ASSIST_TIMEOUT_MS, isAssistJobType, runAssistJob } from './assistJobs'

const STARTED = { success: true, job_id: 'job_1', status: 'pending' }
const identity = (result: unknown) => result

/** The rejection of `promise` (or a marker when it resolved), caught at once so fake time can run. */
function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => 'resolved', (error: unknown) => error)
}

/** A poll stub answering `answers` in order, then repeating the last one. */
function pollAnswers(...answers: unknown[]) {
  const poll = vi.fn<(jobId: string) => Promise<unknown>>()
  answers.forEach((answer) => poll.mockResolvedValueOnce(answer))
  poll.mockResolvedValue(answers.at(-1))
  return poll
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('runAssistJob', () => {
  it('resolves the parsed result when the first poll finds the job completed', async () => {
    const poll = pollAnswers({ status: 'completed', result: { answers: ['a'] } })

    const result = await runAssistJob(() => Promise.resolve(STARTED), poll, (r) => ({ parsed: r }))

    expect(result).toStrictEqual({ parsed: { answers: ['a'] } })
    expect(poll).toHaveBeenCalledWith('job_1')
  })

  it('keeps polling every interval while the job is pending or running', async () => {
    const poll = pollAnswers({ status: 'pending' }, { status: 'running' }, { status: 'completed', result: 7 })

    const outcome = runAssistJob(() => Promise.resolve(STARTED), poll, identity)
    await vi.advanceTimersByTimeAsync(ASSIST_POLL_INTERVAL_MS - 1)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(ASSIST_POLL_INTERVAL_MS + 1)

    await expect(outcome).resolves.toBe(7)
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it('honours a custom poll interval', async () => {
    const poll = pollAnswers({ status: 'running' }, { status: 'completed', result: 'done' })

    const outcome = runAssistJob(() => Promise.resolve(STARTED), poll, identity, { intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(outcome).resolves.toBe('done')
  })

  it('rejects with the job error when the job failed', async () => {
    const poll = pollAnswers({ status: 'failed', error: 'Company description is required' })

    await expect(runAssistJob(() => Promise.resolve(STARTED), poll, identity))
      .rejects.toThrow('Company description is required')
  })

  it('rejects with a generic message when a failed job carries no error', async () => {
    const poll = pollAnswers({ status: 'failed', error: null })

    await expect(runAssistJob(() => Promise.resolve(STARTED), poll, identity))
      .rejects.toThrow('The request failed. Please try again.')
  })

  it('rejects with a timeout once the default fifteen minutes have passed', async () => {
    const poll = pollAnswers({ status: 'running' })

    const outcome = settle(runAssistJob(() => Promise.resolve(STARTED), poll, identity))
    await vi.advanceTimersByTimeAsync(ASSIST_TIMEOUT_MS)

    expect(String(await outcome)).toContain('taking too long')
    expect(poll.mock.calls.length).toBeLessThanOrEqual(ASSIST_TIMEOUT_MS / ASSIST_POLL_INTERVAL_MS + 1)
  })

  it('rejects with a timeout after a custom timeout', async () => {
    const poll = pollAnswers({ status: 'pending' })

    const outcome = settle(runAssistJob(() => Promise.resolve(STARTED), poll, identity, { intervalMs: 10, timeoutMs: 50 }))
    await vi.advanceTimersByTimeAsync(60)

    expect(String(await outcome)).toContain('taking too long')
  })

  it('rejects an AbortError when the signal aborts between polls', async () => {
    const controller = new AbortController()
    const poll = pollAnswers({ status: 'running' })

    const outcome = settle(runAssistJob(() => Promise.resolve(STARTED), poll, identity, { signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()

    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no job id', { success: true, status: 'pending' }],
    ['an empty job id', { job_id: '', status: 'pending' }],
    ['a non-object', 'Accepted'],
  ])('rejects a start answer with %s without polling', async (_label, answer) => {
    const poll = pollAnswers({ status: 'completed' })

    await expect(runAssistJob(() => Promise.resolve(answer), poll, identity))
      .rejects.toThrow('Unexpected response from the server.')
    expect(poll).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown status', { status: 'queued' }],
    ['no status', { result: 1 }],
    ['a non-object', null],
  ])('rejects a poll answer with %s', async (_label, answer) => {
    const poll = pollAnswers(answer)

    await expect(runAssistJob(() => Promise.resolve(STARTED), poll, identity))
      .rejects.toThrow('Unexpected response from the server.')
  })

  it('propagates a failed start request unchanged', async () => {
    const poll = pollAnswers({ status: 'completed' })

    await expect(runAssistJob(() => Promise.reject(new Error('API Error: 403')), poll, identity))
      .rejects.toThrow('API Error: 403')
  })
})

describe('isAssistJobType', () => {
  it.each([
    ['assist_categories', true],
    ['assist_persona_avatar', true],
    ['research', false],
    ['generate_prd', false],
    [undefined, false],
  ])('%s → %s', (jobType, expected) => {
    expect(isAssistJobType(jobType)).toBe(expected)
  })
})
