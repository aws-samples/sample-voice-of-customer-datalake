/**
 * @fileoverview The erasure hooks shared by the person erasure and the
 * whole-source erasure panels: an `erasure-jobs` query (`GET /settings/erasure`
 * → `{jobs, sources}`) per scope, polled every two seconds while any job is
 * queued or running: the deployment's (the whole-source panel: its jobs and the
 * source picker, from one request) and, inside a workspace, that workspace's
 * (the person erasure panel; outside one both panels read the same query); and
 * the start mutation that refreshes them.
 *
 * When a poll shows that a job it saw live has ended, every feedback view is
 * refreshed (`invalidateFeedbackData`): the erasure moved the counts. With push
 * (docs/realtime.md) the job's end notice re-reads the list at once, and the poll
 * slows to the fallback.
 *
 * @module components/SourcesManager/useErasureJobs
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { invalidateFeedbackData } from '../../api/invalidateFeedbackData'
import { erasureEnded, erasureJobsKey, isLiveErasure, sourceProfilesApi } from '../../api/sourceProfilesApi'
import type { ErasureJob, ErasureList } from '../../api/sourceProfilesApi'
import { realtimePollInterval, useRealtimeJobRefresh } from '../../realtime/jobRefresh'
import type { RequestScope } from '../../api/baseUrl'
import { scopedKey } from '../../workspace/configScope'

const POLL_INTERVAL_MS = 2_000
/** The notice's `job_type` for an erasure job (lambda/jobs/retention/runs.py ERASURE_JOB_TYPE). */
const ERASURE_JOB_TYPE = 'erasure'

/** Read the list; when a job the cached list showed live has ended, refresh the feedback views. */
async function fetchErasureList(queryClient: QueryClient, scope: RequestScope): Promise<ErasureList> {
  // Only this query's own queryFn writes the key, so the cached value is an ErasureList or absent.
  const cached = queryClient.getQueryData<ErasureList>(scopedKey(erasureJobsKey(), scope))
  const next = await sourceProfilesApi.listErasure(scope)
  if (cached !== undefined && erasureEnded(cached.jobs, next.jobs)) void invalidateFeedbackData(queryClient)
  return next
}

function useErasureList<T>(select: (list: ErasureList) => T, scope: RequestScope) {
  const queryClient = useQueryClient()
  useRealtimeJobRefresh({ jobType: ERASURE_JOB_TYPE }, [erasureJobsKey()])
  return useQuery({
    // The deployment's list under its own key (it starts with the shared one, so an invalidation reaches both).
    queryKey: scopedKey(erasureJobsKey(), scope),
    queryFn: () => fetchErasureList(queryClient, scope),
    select,
    refetchInterval: (query) => ((query.state.data?.jobs ?? []).some(isLiveErasure)
      ? realtimePollInterval(POLL_INTERVAL_MS)
      : false),
  })
}

const selectJobs = (list: ErasureList): ErasureJob[] => list.jobs
const selectSources = (list: ErasureList): string[] => list.sources

/** The jobs of the current workspace (`'workspace'`, the default: the person erasure panel) or the deployment's
 *  (`'deployment'`: the whole-source panel, whose erasures are the deployment's only). */
export function useErasureJobs(scope: RequestScope = 'workspace') {
  return useErasureList(selectJobs, scope)
}

/** The source ids a whole-source erasure may name: the deployment's, from the same query as its jobs. */
export function useErasableSources() {
  return useErasureList(selectSources, 'deployment')
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
