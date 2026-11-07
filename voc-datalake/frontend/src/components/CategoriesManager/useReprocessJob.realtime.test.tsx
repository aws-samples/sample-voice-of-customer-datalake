/** useLatestJob with push (docs/realtime.md): the reprocess job's end notice re-reads it at once; the poll stays. */
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reprocessApi } from '../../api/reprocessApi'
import { deliverNotice, setRealtimeLive } from '../../realtime/hub'
import { createQueryWrapper } from '../../test/query-client'
import { useLatestJob } from './useReprocessJob'

const mount = () => renderHook(() => useLatestJob(), { wrapper: createQueryWrapper() })

const getLatest = vi.spyOn(reprocessApi, 'getLatest')

beforeEach(() => {
  setRealtimeLive(false)
  getLatest.mockResolvedValue(null)
})
afterEach(() => {
  setRealtimeLive(false)
  getLatest.mockReset()
})

describe('useLatestJob job notices', () => {
  it('re-reads on a reprocess notice, not on another job\'s', async () => {
    mount()
    await waitFor(() => { expect(getLatest).toHaveBeenCalledTimes(1) })
    deliverNotice({ type: 'job', job_id: 'er_1', status: 'completed', job_type: 'erasure' })
    deliverNotice({ type: 'job', job_id: 'rp_1', status: 'completed', job_type: 'category_reprocess' })
    await waitFor(() => { expect(getLatest).toHaveBeenCalledTimes(2) })
  })

  it('re-reads on a reconnect', async () => {
    mount()
    await waitFor(() => { expect(getLatest).toHaveBeenCalledTimes(1) })
    setRealtimeLive(true)
    await waitFor(() => { expect(getLatest).toHaveBeenCalledTimes(2) })
  })
})
