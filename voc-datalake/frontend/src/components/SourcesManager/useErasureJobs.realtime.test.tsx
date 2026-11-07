/** useErasureJobs with push (docs/realtime.md): an erasure job's end notice re-reads the list at once. */
import { renderHook } from '@testing-library/react'
import { afterEach, describe, it, vi } from 'vitest'
import { sourceProfilesApi } from '../../api/sourceProfilesApi'
import { createQueryWrapper } from '../../test/query-client'
import { expectRereadOnItsNotice, expectRereadOnReconnect, type JobNoticeRefreshCase } from '../../test/realtimeJobRefresh'
import { useErasureJobs } from './useErasureJobs'

function view(): JobNoticeRefreshCase {
  const read = vi.spyOn(sourceProfilesApi, 'listErasure').mockResolvedValue({ jobs: [], sources: [] })
  return {
    read,
    mount: () => renderHook(() => useErasureJobs(), { wrapper: createQueryWrapper() }),
    notice: { type: 'job', job_id: 'er_1', status: 'completed', job_type: 'erasure' },
    otherNotice: { type: 'job', job_id: 'rp_1', status: 'completed', job_type: 'category_reprocess' },
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('useErasureJobs job notices', () => {
  it('re-reads at once on its own notice, not on another job\'s', async () => { await expectRereadOnItsNotice(view()) })
  it('re-reads on a reconnect', async () => { await expectRereadOnReconnect(view()) })
})
