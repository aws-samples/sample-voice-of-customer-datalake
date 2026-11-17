/**
 * @fileoverview The run workspace's reads and actions (7.51.00; api/engineeringRunWorkspaceApi.ts). The overview is
 * the run monitor's, polled every 5 s while the run is under way (useEngineeringRun.ts). An open thread is read by
 * its cursor: from its start, then from where the last page left off (`after = next`), every
 * {@link THREAD_POLL_MS} until the server says it is done, sooner while a full page says more is waiting; each page
 * merged into what is known by ref (threadModel.ts). Polling is D51-5's choice; the push comes in 7.53.
 *
 * The inspector's reads happen when their tab is open: an agent's changes (kept {@link CHANGES_STALE_MS}, as KiroCrew's
 * GitBranchChanges does), one file's part of a patch only once opened (a patch never changes), and its files, gate
 * and memory every {@link INSPECTOR_POLL_MS} while the run is under way.
 *
 * @module pages/Agents/RunWorkspace/useRunWorkspace
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { THREAD_PAGE, runWorkspaceApi, runWorkspaceKeys } from '../../../api/engineeringRunWorkspaceApi'
import { engineeringRunsKeys } from '../../../api/engineeringRunsApi'
import { retryOnceUnlessNotFound } from '../../../api/apiErrorStatus'
import { useRunReadable } from '../useEngineeringRun'
import { EMPTY_THREAD, mergeThread } from './threadModel'
import type { QueryKey } from '@tanstack/react-query'
import type { RestartRequest, SteerRequest } from '../../../api/engineeringRunWorkspaceApi'
import type { ThreadState } from './threadModel'

const THREAD_POLL_MS = 5000
/** The next read after a full page: more is waiting now. */
const CATCH_UP_MS = 500
const INSPECTOR_POLL_MS = 15_000
const CHANGES_STALE_MS = 30_000

/** When to read a thread again: never once it is done or a read failed; soon after a full page; else every 5 s. */
function threadInterval(state: { status: string; data?: ThreadState }): number | false {
  const every = state.data?.full === true ? CATCH_UP_MS : THREAD_POLL_MS
  return state.status === 'error' || state.data === undefined || state.data.done ? false : every
}

/** An agent's thread (null: none to read yet), every page merged into one list by ref. */
export function useAgentThread(runId: string, agent: string | null) {
  const queryClient = useQueryClient()
  const queryKey = runWorkspaceKeys.thread(runId, agent ?? '')
  return useQuery({
    queryKey,
    queryFn: async (): Promise<ThreadState> => {
      const known = queryClient.getQueryData<ThreadState>(queryKey) ?? EMPTY_THREAD
      const page = await runWorkspaceApi.thread(runId, agent ?? '', known.next)
      return {
        items: mergeThread(known.items, page.items), next: page.next ?? known.next, done: page.done,
        full: page.items.length >= THREAD_PAGE,
      }
    },
    enabled: useRunReadable(runId) && agent !== null,
    retry: retryOnceUnlessNotFound,
    refetchInterval: (query) => threadInterval(query.state),
  })
}

/** One thread item whole (its event and its result), read once it is opened, again when the item changed since. */
export function useThreadItem(runId: string, agent: string, ref: string, version: string, open: boolean) {
  return useQuery({
    queryKey: runWorkspaceKeys.threadItem(runId, agent, ref, version),
    queryFn: () => runWorkspaceApi.threadItem(runId, agent, ref),
    enabled: useRunReadable(runId) && open,
    staleTime: Infinity,
    retry: retryOnceUnlessNotFound,
  })
}

/** An agent's changes from one of its patches (`key` '': its submitted one, else its latest checkpoint's). */
export function useAgentChanges(runId: string, agent: string, key: string) {
  return useQuery({
    queryKey: runWorkspaceKeys.changes(runId, agent, key),
    queryFn: () => runWorkspaceApi.changes(runId, agent, key),
    enabled: useRunReadable(runId),
    staleTime: CHANGES_STALE_MS,
    retry: retryOnceUnlessNotFound,
  })
}

/** One file's part of a patch, read when the file is opened (collapsed until then, as KiroCrew's GitBranchChanges). */
export function useChangeFile(runId: string, agent: string, key: string, path: string, open: boolean) {
  return useQuery({
    queryKey: runWorkspaceKeys.changeFile(runId, agent, key, path),
    queryFn: () => runWorkspaceApi.changeFile(runId, agent, key, path),
    enabled: useRunReadable(runId) && open,
    staleTime: Infinity,
    retry: retryOnceUnlessNotFound,
  })
}

/** A read of the inspector's, polled while the run is under way. */
function useInspectorRead<T>(runId: string, queryKey: QueryKey, read: () => Promise<T>, live: boolean) {
  return useQuery({
    queryKey,
    queryFn: read,
    enabled: useRunReadable(runId),
    retry: retryOnceUnlessNotFound,
    refetchInterval: (query) => (live && query.state.status !== 'error' ? INSPECTOR_POLL_MS : false),
  })
}

export const useAgentFiles = (runId: string, agent: string, live: boolean) =>
  useInspectorRead(runId, runWorkspaceKeys.inspector(runId, agent, 'files'), () => runWorkspaceApi.files(runId, agent), live)

export const useAgentGate = (runId: string, agent: string, live: boolean) =>
  useInspectorRead(runId, runWorkspaceKeys.inspector(runId, agent, 'gate'), () => runWorkspaceApi.gate(runId, agent), live)

export const useAgentMemory = (runId: string, agent: string, live: boolean) =>
  useInspectorRead(runId, runWorkspaceKeys.inspector(runId, agent, 'memory'), () => runWorkspaceApi.memory(runId, agent), live)

export const useRunAssertions = (runId: string, live: boolean) =>
  useInspectorRead(runId, runWorkspaceKeys.assertions(runId), () => runWorkspaceApi.assertions(runId), live)

/**
 * A person's steering, to the run's orchestrator (never an agent: an agent hears it only as the orchestrator relays
 * it). The conversation records it, so the threads and the overview read again.
 */
export function useSteer(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: SteerRequest) => runWorkspaceApi.steer(runId, request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: engineeringRunsKeys.overview(runId) })
      void queryClient.invalidateQueries({ queryKey: runWorkspaceKeys.threads(runId) })
    },
  })
}

/** An ended run started again as a child run (the dialog opens the child). */
export function useRestartRun(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: RestartRequest) => runWorkspaceApi.restart(runId, request),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: engineeringRunsKeys.overview(runId) }) },
  })
}
