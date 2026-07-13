/**
 * Unit tests for the shared job-polling helper.
 *
 * Uses fake timers: pollJobToCompletion sleeps between polls, so tests
 * advance the clock instead of waiting. projectsApi is mocked at the
 * import boundary.
 */
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest'
import { pollJobToCompletion } from './jobPolling'
import type { ProjectJob } from '../../api/types'

const mockGetJobStatus = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getJobStatus: (projectId: string, jobId: string) => mockGetJobStatus(projectId, jobId),
  },
}))

function job(status: ProjectJob['status'], error?: string): ProjectJob {
  return {
    job_id: 'job-1',
    job_type: 'build_prototype',
    status,
    progress: 0,
    created_at: '2026-07-13T00:00:00Z',
    ...(error ? { error } : {}),
  }
}

describe('pollJobToCompletion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockGetJobStatus.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns completed with the job when the job completes', async () => {
    mockGetJobStatus.mockResolvedValue(job('completed'))

    const promise = pollJobToCompletion('proj-1', 'job-1')
    await vi.advanceTimersByTimeAsync(3000)

    await expect(promise).resolves.toEqual({ status: 'completed', job: job('completed') })
    expect(mockGetJobStatus).toHaveBeenCalledWith('proj-1', 'job-1')
  })

  it('returns failed with the job (and its error) when the job fails', async () => {
    mockGetJobStatus.mockResolvedValue(job('failed', 'boom'))

    const promise = pollJobToCompletion('proj-1', 'job-1')
    await vi.advanceTimersByTimeAsync(3000)

    await expect(promise).resolves.toEqual({ status: 'failed', job: job('failed', 'boom') })
  })

  it('keeps polling while the job is running, then resolves on completion', async () => {
    mockGetJobStatus
      .mockResolvedValueOnce(job('running'))
      .mockResolvedValueOnce(job('running'))
      .mockResolvedValueOnce(job('completed'))

    const promise = pollJobToCompletion('proj-1', 'job-1')
    await vi.advanceTimersByTimeAsync(3 * 3000)

    await expect(promise).resolves.toMatchObject({ status: 'completed' })
    expect(mockGetJobStatus).toHaveBeenCalledTimes(3)
  })

  it('returns timeout when the deadline passes without a terminal status', async () => {
    mockGetJobStatus.mockResolvedValue(job('running'))

    const promise = pollJobToCompletion('proj-1', 'job-1', { timeoutMs: 10_000, intervalMs: 3000 })
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(promise).resolves.toEqual({ status: 'timeout' })
  })

  it('tolerates transient poll errors below the threshold and still resolves', async () => {
    mockGetJobStatus
      .mockRejectedValueOnce(new Error('net down'))
      .mockRejectedValueOnce(new Error('net down'))
      .mockResolvedValueOnce(job('completed'))

    const promise = pollJobToCompletion('proj-1', 'job-1')
    // 1 poll sleep + 2 retry sleeps
    await vi.advanceTimersByTimeAsync(3 * 3000)

    await expect(promise).resolves.toMatchObject({ status: 'completed' })
    expect(mockGetJobStatus).toHaveBeenCalledTimes(3)
  })

  it('rethrows after the configured number of consecutive poll errors', async () => {
    mockGetJobStatus.mockRejectedValue(new Error('net down'))

    const promise = pollJobToCompletion('proj-1', 'job-1', { maxConsecutiveErrors: 3 })
    // Attach the rejection expectation BEFORE advancing timers to avoid an unhandled rejection.
    const assertion = expect(promise).rejects.toThrow('net down')
    await vi.advanceTimersByTimeAsync(4 * 3000)

    await assertion
    expect(mockGetJobStatus).toHaveBeenCalledTimes(3)
  })

  it('resets the error count after a successful poll', async () => {
    // 4 errors, success (running), 4 errors, success (completed):
    // never hits 5 consecutive, so it must resolve rather than throw.
    mockGetJobStatus
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockRejectedValueOnce(new Error('e3'))
      .mockRejectedValueOnce(new Error('e4'))
      .mockResolvedValueOnce(job('running'))
      .mockRejectedValueOnce(new Error('e5'))
      .mockRejectedValueOnce(new Error('e6'))
      .mockRejectedValueOnce(new Error('e7'))
      .mockRejectedValueOnce(new Error('e8'))
      .mockResolvedValueOnce(job('completed'))

    const promise = pollJobToCompletion('proj-1', 'job-1')
    await vi.advanceTimersByTimeAsync(10 * 3000)

    await expect(promise).resolves.toMatchObject({ status: 'completed' })
    expect(mockGetJobStatus).toHaveBeenCalledTimes(10)
  })
})
