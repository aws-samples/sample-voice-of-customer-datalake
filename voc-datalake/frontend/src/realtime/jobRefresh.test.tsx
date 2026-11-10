/** realtime/jobRefresh.ts: a job view re-reads on its notice and on a reconnect; the poll stays as the fallback. */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverNotice, setRealtimeLive } from './hub'
import {
  SUBSCRIBED_JOB_POLL_INTERVAL_MS, isMatchingJobNotice, realtimePollInterval, subscribedPollInterval, useRealtimeJobRefresh,
  type JobNoticeMatch,
} from './jobRefresh'
import { createQueryWrapper, createTestQueryClient } from '../test/query-client'

const job = (fields: Record<string, string> = {}) => ({ type: 'job' as const, job_id: 'j1', status: 'completed', ...fields })

function mount(match: JobNoticeMatch, enabled = true) {
  const queryClient = createTestQueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
  const wrapper = createQueryWrapper(queryClient)
  const view = renderHook(({ on }: { on: boolean }) => { useRealtimeJobRefresh(match, [['a'], ['b', 1]], on) },
    { wrapper, initialProps: { on: enabled } })
  return { invalidate, view }
}

beforeEach(() => { setRealtimeLive(false) })
afterEach(() => { setRealtimeLive(false) })

describe('realtimePollInterval', () => {
  it('keeps the interval without push', () => {
    expect(realtimePollInterval(2000)).toBe(2000)
  })

  it('slows to the subscribed fallback while live, never speeds up', () => {
    setRealtimeLive(true)
    expect(realtimePollInterval(2000)).toBe(SUBSCRIBED_JOB_POLL_INTERVAL_MS)
    expect(realtimePollInterval(60_000)).toBe(60_000)
    expect(subscribedPollInterval(1)).toBe(SUBSCRIBED_JOB_POLL_INTERVAL_MS)
  })
})

describe('isMatchingJobNotice', () => {
  const notice = job({ job_type: 'erasure', project_id: 'p1' })

  it.each<[JobNoticeMatch, boolean]>([
    [{}, true],
    [{ jobType: 'erasure', projectId: 'p1', jobId: 'j1' }, true],
    [{ jobType: ['memory_import', 'erasure'] }, true],
    [{ jobType: 'category_reprocess' }, false],
    [{ projectId: 'p2' }, false],
    [{ jobId: 'j2' }, false],
  ])('%o matches: %s', (match, expected) => {
    expect(isMatchingJobNotice(notice, match)).toBe(expected)
  })

  it('a notice without a job type never matches a type', () => {
    expect(isMatchingJobNotice(job(), { jobType: 'erasure' })).toBe(false)
  })

  it('ignores the other notice kinds', () => {
    expect(isMatchingJobNotice({ type: 'plan', plan_id: 'p', change: 'plan_finished' }, {})).toBe(false)
  })
})

describe('useRealtimeJobRefresh', () => {
  it('invalidates every key on a matching notice, nothing on another', () => {
    const { invalidate } = mount({ jobType: 'erasure' })
    deliverNotice(job({ job_type: 'category_reprocess' }))
    expect(invalidate).not.toHaveBeenCalled()
    deliverNotice(job({ job_type: 'erasure' }))
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toStrictEqual([['a'], ['b', 1]])
  })

  it('invalidates on a (re)connect: a notice may have been missed', () => {
    const { invalidate } = mount({ jobType: 'erasure' })
    setRealtimeLive(true)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('does nothing while disabled, and stops listening on unmount', () => {
    const { invalidate, view } = mount({}, false)
    deliverNotice(job())
    expect(invalidate).not.toHaveBeenCalled()
    view.rerender({ on: true })
    view.unmount()
    deliverNotice(job())
    setRealtimeLive(true)
    expect(invalidate).not.toHaveBeenCalled()
  })
})
