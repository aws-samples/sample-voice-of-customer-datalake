/**
 * @fileoverview The erasure job list, shared by the person erasure and the
 * whole-source erasure panels. One query (`erasure-jobs`), polled every two
 * seconds while any job is queued or running, so both panels show the same
 * live counts.
 *
 * @module components/SourcesManager/useErasureJobs
 */
import { useQuery } from '@tanstack/react-query'
import { erasureJobsKey, isLiveErasure, sourceProfilesApi } from '../../api/sourceProfilesApi'

const POLL_INTERVAL_MS = 2_000

export function useErasureJobs() {
  return useQuery({
    queryKey: erasureJobsKey(),
    queryFn: () => sourceProfilesApi.listErasureJobs(),
    refetchInterval: (query) => ((query.state.data ?? []).some(isLiveErasure) ? POLL_INTERVAL_MS : false),
  })
}
