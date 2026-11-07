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
import { realtimePollInterval, useRealtimeJobRefresh } from '../../realtime/jobRefresh'

/** How often a running job is re-read (slower while push is live: its end arrives as a notice). */
const POLL_INTERVAL_MS = 2_000

/** The notice's `job_type` for a reprocess job (lambda/shared/reprocess_jobs.py JOB_TYPE). */
const REPROCESS_JOB_TYPE = 'category_reprocess'

/** The latest job, polled while it is still moving, and re-read at once when it ends (docs/realtime.md). */
export function useLatestJob() {
  useRealtimeJobRefresh({ jobType: REPROCESS_JOB_TYPE }, [latestReprocessJobKey()])
  return useQuery({
    queryKey: latestReprocessJobKey(),
    queryFn: () => reprocessApi.getLatest(),
    refetchInterval: (query) => {
      const job = query.state.data
      return job != null && !isTerminalJob(job) ? realtimePollInterval(POLL_INTERVAL_MS) : false
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
