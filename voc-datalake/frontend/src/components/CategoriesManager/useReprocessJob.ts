/**
 * @fileoverview The reprocess job queries shared by the Categories reprocess panel and
 * the Dimensions "Classify review types" card: both read and start the ONE job the
 * backend allows at a time per scope (`/settings/categories/reprocess`).
 *
 * Whose job (workspace/configScope.ts, since 7.13.00): the enclosing editor's scope. On a workspace's settings page
 * (`'workspace'`) the calls name the workspace, so they start, poll and cancel that workspace's own job; in
 * Administration (`'deployment'`) they never do, so the panel stays the deployment's, from any address. Each scope's
 * latest job is cached under its own key (`scopedKey`), which still starts with the shared root.
 *
 * @module components/CategoriesManager/useReprocessJob
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isTerminalJob, latestReprocessJobKey, reprocessApi } from '../../api/reprocessApi'
import type { ReprocessJob, ReprocessRequest } from '../../api/reprocessApi'
import { realtimePollInterval, useRealtimeJobRefresh } from '../../realtime/jobRefresh'
import { scopedKey, useConfigScope } from '../../workspace/configScope'

/** How often a running job is re-read (slower while push is live: its end arrives as a notice). */
const POLL_INTERVAL_MS = 2_000

/** The notice's `job_type` for a reprocess job (lambda/shared/reprocess_jobs.py JOB_TYPE). */
const REPROCESS_JOB_TYPE = 'category_reprocess'

/** The latest job of the editor's scope, polled while it is still moving, and re-read at once when it ends
 *  (docs/realtime.md). */
export function useLatestJob() {
  const scope = useConfigScope()
  useRealtimeJobRefresh({ jobType: REPROCESS_JOB_TYPE }, [latestReprocessJobKey()])
  return useQuery({
    queryKey: scopedKey(latestReprocessJobKey(), scope),
    queryFn: () => reprocessApi.getLatest(scope),
    refetchInterval: (query) => {
      const job = query.state.data
      return job != null && !isTerminalJob(job) ? realtimePollInterval(POLL_INTERVAL_MS) : false
    },
  })
}

/** Start and cancel in the editor's scope; both store the answered job so the progress shows at once. */
export function useReprocessMutations(onStarted: () => void) {
  const scope = useConfigScope()
  const queryClient = useQueryClient()
  const store = (job: ReprocessJob | null) => {
    if (job !== null) queryClient.setQueryData(scopedKey(latestReprocessJobKey(), scope), job)
    void queryClient.invalidateQueries({ queryKey: latestReprocessJobKey() })
  }
  const start = useMutation({
    mutationFn: (request: ReprocessRequest) => reprocessApi.start(request, scope),
    onSuccess: (job) => { store(job); onStarted() },
  })
  const cancel = useMutation({
    mutationFn: (jobId: string) => reprocessApi.cancel(jobId, scope),
    onSuccess: store,
  })
  return { start, cancel }
}
