import { describe, it, expect, vi } from 'vitest'
import { NO_FAILED_READS, failedReads } from './failedReads'
import type { RetryableRead } from './failedReads'

const read = (over: Partial<RetryableRead> = {}): RetryableRead => ({
  data: undefined, isError: false, isFetching: false, refetch: vi.fn(() => Promise.resolve()), ...over,
})

describe('failedReads', () => {
  it('a read that errored with no data is a load failure', () => {
    expect(failedReads([read({ isError: true })]).loadFailed).toBe(true)
  })

  it('an errored refetch over cached data is not: the data still shows', () => {
    expect(failedReads([read({ isError: true, data: { items: [] } })]).loadFailed).toBe(false)
  })

  it('an empty successful read is not a failure (it is the empty state)', () => {
    expect(failedReads([read({ data: { items: [] } })])).toMatchObject({ loadFailed: false, retrying: false })
  })

  it('retry refetches only the failed reads', () => {
    const failed = read({ isError: true })
    const fine = read({ data: {} })
    failedReads([failed, fine]).retry()
    expect(failed.refetch).toHaveBeenCalledExactlyOnceWith()
    expect(fine.refetch).not.toHaveBeenCalled()
  })

  it('is retrying while a failed read refetches', () => {
    expect(failedReads([read({ isError: true, isFetching: true })]).retrying).toBe(true)
  })

  it('NO_FAILED_READS says nothing failed', () => {
    expect(NO_FAILED_READS).toMatchObject({ loadFailed: false, retrying: false })
    expect(() => NO_FAILED_READS.retry()).not.toThrow()
  })
})
