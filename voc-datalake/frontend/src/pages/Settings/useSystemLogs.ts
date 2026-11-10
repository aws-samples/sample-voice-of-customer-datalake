/**
 * @fileoverview The System errors tab's queries: `GET /logs/system` and
 * `GET /logs/system/request`, each polled with the answer's `query_id` every
 * {@link POLL_MS} while the CloudWatch Logs Insights search is still `running`;
 * plus the failure queues and the environment (`/logs/system/queues`,
 * `/logs/system/environment`). Every route is admin-only: call these only for an admin.
 * @module pages/Settings/useSystemLogs
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { SystemLogFilter, SystemLogGroup, SystemLogs } from '../../api/systemLogs'
import type { SystemRequest } from '../../api/systemDiagnostics'

/** How often a running search is polled. */
const POLL_MS = 2000

const systemLogsKey = (days: number, level: SystemLogFilter) => ['system-logs', days, level] as const

/** One group's whole-request lines: its function, request id and newest occurrence. */
const systemRequestKey = (group: SystemLogGroup) =>
  ['system-log-request', group.function, group.request_id, group.last_seen] as const

export const SYSTEM_QUEUES_KEY = ['system-log-queues'] as const
export const SYSTEM_ENVIRONMENT_KEY = ['system-log-environment'] as const

/** The query id to poll with: only while the cached answer is still running. */
function runningQueryId(previous: { status: string; query_id?: string } | undefined): string | undefined {
  return previous?.status === 'running' ? previous.query_id : undefined
}

const pollWhileRunning = (query: { state: { data?: { status: string } } }) =>
  query.state.data?.status === 'running' ? POLL_MS : false

export function useSystemLogs(days: number, level: SystemLogFilter) {
  const queryClient = useQueryClient()
  const key = systemLogsKey(days, level)
  return useQuery({
    queryKey: key,
    // A refetch after a complete/failed answer starts a fresh search; one after a
    // running answer reads that search's results.
    queryFn: () => api.getSystemLogs({
      days, level, query_id: runningQueryId(queryClient.getQueryData<SystemLogs>(key)),
    }),
    refetchInterval: pollWhileRunning,
  })
}

/**
 * Every line of the group's newest invocation, loaded only once `enabled` (the
 * admin asked for it). The answer stays cached for the session, so the download
 * can include every request the admin opened, also after its row was collapsed.
 */
export function useSystemRequest(group: SystemLogGroup, enabled: boolean) {
  const queryClient = useQueryClient()
  const key = systemRequestKey(group)
  return useQuery({
    queryKey: key,
    queryFn: () => api.getSystemRequest({
      function: group.function,
      request_id: group.request_id ?? '',
      at: group.last_seen,
      query_id: runningQueryId(queryClient.getQueryData<SystemRequest>(key)),
    }),
    enabled: enabled && group.request_id !== null,
    gcTime: Infinity,
    staleTime: Infinity,
    refetchInterval: pollWhileRunning,
  })
}

/** The completed whole-request answers cached for these groups, by group. */
export function openedRequests(
  queryClient: QueryClient, groups: readonly SystemLogGroup[],
): Map<SystemLogGroup, SystemRequest> {
  const opened = new Map<SystemLogGroup, SystemRequest>()
  for (const group of groups) {
    const answer = queryClient.getQueryData<SystemRequest>(systemRequestKey(group))
    if (answer?.status === 'complete') opened.set(group, answer)
  }
  return opened
}

export function useSystemFailureQueues() {
  return useQuery({ queryKey: SYSTEM_QUEUES_KEY, queryFn: () => api.getSystemFailureQueues() })
}

export function useSystemEnvironment() {
  return useQuery({ queryKey: SYSTEM_ENVIRONMENT_KEY, queryFn: () => api.getSystemEnvironment() })
}
