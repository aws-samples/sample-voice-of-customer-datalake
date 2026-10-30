/**
 * @fileoverview The erasure hooks shared by the person erasure and the
 * whole-source erasure panels: ONE `erasure-jobs` query (`GET /settings/erasure`
 * → `{jobs, sources}`), polled every two seconds while any job is queued or
 * running, so both panels show the same live counts and the source picker costs
 * no second request; and the start mutation that refreshes it.
 *
 * When a poll shows that a job it saw live has ended, every feedback view is
 * refreshed (`invalidateFeedbackData`): the erasure moved the counts.
 *
 * @module components/SourcesManager/useErasureJobs
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { invalidateFeedbackData } from '../../api/invalidateFeedbackData'
import { erasureEnded, erasureJobsKey, isLiveErasure, sourceProfilesApi } from '../../api/sourceProfilesApi'
import type { ErasureJob, ErasureList } from '../../api/sourceProfilesApi'

const POLL_INTERVAL_MS = 2_000

/** Read the list; when a job the cached list showed live has ended, refresh the feedback views. */
async function fetchErasureList(queryClient: QueryClient): Promise<ErasureList> {
  // Only this query's own queryFn writes the key, so the cached value is an ErasureList or absent.
  const cached = queryClient.getQueryData<ErasureList>(erasureJobsKey())
  const next = await sourceProfilesApi.listErasure()
  if (cached !== undefined && erasureEnded(cached.jobs, next.jobs)) void invalidateFeedbackData(queryClient)
  return next
}

function useErasureList<T>(select: (list: ErasureList) => T) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: erasureJobsKey(),
    queryFn: () => fetchErasureList(queryClient),
    select,
    refetchInterval: (query) => ((query.state.data?.jobs ?? []).some(isLiveErasure) ? POLL_INTERVAL_MS : false),
  })
}

const selectJobs = (list: ErasureList): ErasureJob[] => list.jobs
const selectSources = (list: ErasureList): string[] => list.sources

export function useErasureJobs() {
  return useErasureList(selectJobs)
}

/** The source ids a whole-source erasure may name, from the same query as the jobs. */
export function useErasableSources() {
  return useErasureList(selectSources)
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
