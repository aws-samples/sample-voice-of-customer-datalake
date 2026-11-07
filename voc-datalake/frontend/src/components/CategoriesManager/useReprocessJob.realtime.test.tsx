/** useLatestJob with push (docs/realtime.md): the reprocess job's end notice re-reads it at once; the poll stays. */
import { renderHook } from '@testing-library/react'
import { afterEach, describe, it, vi } from 'vitest'
import { reprocessApi } from '../../api/reprocessApi'
import { createQueryWrapper } from '../../test/query-client'
import { expectRereadOnItsNotice, expectRereadOnReconnect, type JobNoticeRefreshCase } from '../../test/realtimeJobRefresh'
import { useLatestJob } from './useReprocessJob'

function view(): JobNoticeRefreshCase {
  const read = vi.spyOn(reprocessApi, 'getLatest').mockResolvedValue(null)
  return {
    read,
    mount: () => renderHook(() => useLatestJob(), { wrapper: createQueryWrapper() }),
    notice: { type: 'job', job_id: 'rp_1', status: 'completed', job_type: 'category_reprocess' },
    otherNotice: { type: 'job', job_id: 'er_1', status: 'completed', job_type: 'erasure' },
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('useLatestJob job notices', () => {
  it('re-reads at once on its own notice, not on another job\'s', async () => { await expectRereadOnItsNotice(view()) })
  it('re-reads on a reconnect', async () => { await expectRereadOnReconnect(view()) })
})
