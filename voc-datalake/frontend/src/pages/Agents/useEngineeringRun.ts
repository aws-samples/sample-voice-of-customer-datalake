/**
 * @fileoverview The run monitor's reads and actions (api/engineeringRunsApi.ts).
 *
 * The overview, the board and the conversation are polled every {@link ENGINEERING_POLL_MS} while the run has not
 * ended; the report index every {@link REPORTS_POLL_MS} (read only while the Reports panel that uses it is
 * mounted). Polling is the fallback the plan names (v3 4.10): the push over the sample's AppSync Events channels is
 * a later item. The conversation is read from where the last page left off (`after = next_after`), and each page is
 * merged into what is known by seq, so the window the server re-reads on every page keeps each message once.
 *
 * @module pages/Agents/useEngineeringRun
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { engineeringRunsApi, engineeringRunsKeys } from '../../api/engineeringRunsApi'
import { mergeBySeq } from '../../api/seqPages'
import { retryOnceUnlessNotFound } from '../../api/apiErrorStatus'
import { useConfigStore } from '../../store/configStore'
import type { AnswerRequest, BoardAction, ConversationMessage, NewTask, SignalRequest } from '../../api/engineeringRunsApi'

const ENGINEERING_POLL_MS = 5000
/** The report index changes only when the builder writes a version: read less often. */
const REPORTS_POLL_MS = 15_000

interface Tail {
  messages: ConversationMessage[]
  after: number
}

const EMPTY_TAIL: Tail = { messages: [], after: 0 }

function useEnabled(runId: string): boolean {
  return useConfigStore((s) => s.config.apiEndpoint) !== '' && runId !== ''
}

/** What polling reads of a query: whether its last read failed. */
interface PollState {
  state: { status: string }
}

/** Poll while `live` and the query's last read did not fail (an error stops it until the page reads again). */
const pollWhile = (live: boolean, every = ENGINEERING_POLL_MS) => (query: PollState): number | false =>
  (live && query.state.status !== 'error' ? every : false)

/**
 * The run's overview, polled while it has data, its last read did not fail and the run has not ended; `live` says
 * so, and the board and the conversation follow it (a 404 or a failed read stops them all).
 */
export function useEngineeringOverview(runId: string) {
  const enabled = useEnabled(runId)
  const query = useQuery({
    queryKey: engineeringRunsKeys.overview(runId),
    queryFn: () => engineeringRunsApi.overview(runId),
    enabled,
    retry: retryOnceUnlessNotFound,
    refetchInterval: (state) => pollWhile(state.state.data?.run.ended_at === null)(state),
  })
  return { ...query, live: !query.isError && query.data?.run.ended_at === null }
}

export function useEngineeringBoard(runId: string, live: boolean) {
  return useQuery({
    queryKey: engineeringRunsKeys.board(runId),
    queryFn: () => engineeringRunsApi.board(runId),
    enabled: useEnabled(runId),
    refetchInterval: pollWhile(live),
  })
}

export function useEngineeringConversation(runId: string, live: boolean) {
  const queryClient = useQueryClient()
  const queryKey = engineeringRunsKeys.conversation(runId)
  return useQuery({
    queryKey,
    queryFn: async (): Promise<Tail> => {
      const known = queryClient.getQueryData<Tail>(queryKey) ?? EMPTY_TAIL
      const page = await engineeringRunsApi.conversation(runId, known.after)
      return { messages: mergeBySeq(known.messages, page.items), after: page.nextAfter }
    },
    enabled: useEnabled(runId),
    refetchInterval: pollWhile(live),
  })
}

/** The run's report index, read every {@link REPORTS_POLL_MS} while the run is under way (a newer version shows). */
export function useEngineeringReports(runId: string, live: boolean) {
  return useQuery({
    queryKey: engineeringRunsKeys.reports(runId),
    queryFn: () => engineeringRunsApi.reports(runId),
    enabled: useEnabled(runId),
    retry: retryOnceUnlessNotFound,
    refetchInterval: pollWhile(live, REPORTS_POLL_MS),
  })
}

/**
 * What an admin's action changes in the run's reads (the agents' statuses, the board, the conversation that records
 * it): read again. Never the reports: a signal or an answer writes none, and a version once read never changes.
 */
function useRefreshRun(runId: string): () => void {
  const queryClient = useQueryClient()
  const keys = [engineeringRunsKeys.overview(runId), engineeringRunsKeys.board(runId), engineeringRunsKeys.conversation(runId)]
  return () => {
    for (const queryKey of keys) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }
}

/** An admin's signal to the run or to an agent on a task. */
export function useEngineeringSignal(runId: string) {
  const onSuccess = useRefreshRun(runId)
  return useMutation({ mutationFn: (request: SignalRequest) => engineeringRunsApi.signal(runId, request), onSuccess })
}

/** An admin's action on one task (the board, the overview and the conversation read again). */
export function useEngineeringTaskAction(runId: string) {
  const onSuccess = useRefreshRun(runId)
  return useMutation({
    mutationFn: (request: { taskId: string; act: BoardAction }) =>
      engineeringRunsApi.actOnTask(runId, request.taskId, request.act),
    onSuccess,
  })
}

/** An admin posts a task for a role (`duplicate`: an equal task still under way was answered instead). */
export function useEngineeringPostTask(runId: string) {
  const onSuccess = useRefreshRun(runId)
  return useMutation({ mutationFn: (task: NewTask) => engineeringRunsApi.postTask(runId, task), onSuccess })
}

/** An admin's answer to the run's conductor or one of its agents. */
export function useEngineeringAnswer(runId: string) {
  const onSuccess = useRefreshRun(runId)
  return useMutation({ mutationFn: (request: AnswerRequest) => engineeringRunsApi.answer(runId, request), onSuccess })
}
