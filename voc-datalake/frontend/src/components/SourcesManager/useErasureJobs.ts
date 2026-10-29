/**
 * @fileoverview The erasure hooks shared by the person erasure and the
 * whole-source erasure panels: the job list (one `erasure-jobs` query, polled
 * every two seconds while any job is queued or running, so both panels show
 * the same live counts) and the start mutation that refreshes it.
 *
 * @module components/SourcesManager/useErasureJobs
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { erasureJobsKey, isLiveErasure, sourceProfilesApi } from '../../api/sourceProfilesApi'
import type { ErasureJob } from '../../api/sourceProfilesApi'

const POLL_INTERVAL_MS = 2_000

export function useErasureJobs() {
  return useQuery({
    queryKey: erasureJobsKey(),
    queryFn: () => sourceProfilesApi.listErasureJobs(),
    refetchInterval: (query) => ((query.state.data ?? []).some(isLiveErasure) ? POLL_INTERVAL_MS : false),
  })
}

/**
 * Start an erasure job: `onAccepted(job)` after a 202 (`job` is null when its
 * body did not parse), `onRefused()` after a failure; an accepted job
 * refreshes the shared job list.
 */
export function useStartErasure<T>(start: (input: T) => Promise<ErasureJob | null>,
  { onAccepted, onRefused }: { onAccepted: (job: ErasureJob | null) => void; onRefused: () => void }) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: start,
    onSuccess: (job) => {
      onAccepted(job)
      void queryClient.invalidateQueries({ queryKey: erasureJobsKey() })
    },
    onError: onRefused,
  })
}

/** The error's message for the "not started" alert ('' when it carries none). */
export function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : ''
}
