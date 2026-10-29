/**
 * @fileoverview The reprocess job queries shared by the Categories reprocess panel and
 * the Dimensions "Classify review types" card: both read and start the ONE job the
 * backend allows at a time (`/settings/categories/reprocess`).
 *
 * @module components/CategoriesManager/useReprocessJob
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isTerminalJob, latestReprocessJobKey, reprocessApi } from '../../api/reprocessApi'
import type { ReprocessJob, ReprocessRequest } from '../../api/reprocessApi'

/** How often a running job is re-read. */
const POLL_INTERVAL_MS = 2_000

/** The latest job, polled while it is still moving. */
export function useLatestJob() {
  return useQuery({
    queryKey: latestReprocessJobKey(),
    queryFn: () => reprocessApi.getLatest(),
    refetchInterval: (query) => {
      const job = query.state.data
      return job != null && !isTerminalJob(job) ? POLL_INTERVAL_MS : false
    },
  })
}

/** Start and cancel; both store the answered job so the progress shows at once. */
export function useReprocessMutations(onStarted: () => void) {
  const queryClient = useQueryClient()
  const store = (job: ReprocessJob | null) => {
    if (job !== null) queryClient.setQueryData(latestReprocessJobKey(), job)
    void queryClient.invalidateQueries({ queryKey: latestReprocessJobKey() })
  }
  const start = useMutation({
    mutationFn: (request: ReprocessRequest) => reprocessApi.start(request),
    onSuccess: (job) => { store(job); onStarted() },
  })
  const cancel = useMutation({
    mutationFn: (jobId: string) => reprocessApi.cancel(jobId),
    onSuccess: store,
  })
  return { start, cancel }
}
