/**
 * @fileoverview Queries and mutations of the Autonomous agents pages.
 *
 * @module pages/Agents/useAgents
 */
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { agentsApi, agentsKeys, isActiveRun } from '../../api/agentsApi'
import { mergeEvents } from '../../components/WorkflowEditor/runState'
import { useConfigStore } from '../../store/configStore'
import type { Agent, AgentForm, AgentRun, RunEvent } from '../../api/agentsApi'

/** Run list / run detail refresh while something is in flight. */
export const RUN_POLL_MS = 4000

function useEnabled(): boolean {
  return useConfigStore((s) => s.config.apiEndpoint) !== ''
}

export function useAgentList() {
  const enabled = useEnabled()
  return useQuery({ queryKey: agentsKeys.list(), queryFn: agentsApi.list, enabled })
}

export function useAgent(agentId: string) {
  const enabled = useEnabled()
  return useQuery({ queryKey: agentsKeys.detail(agentId), queryFn: () => agentsApi.get(agentId), enabled })
}

/** Writes on one agent; every success refreshes the agent and the list. */
export function useAgentMutations(agentId: string) {
  const queryClient = useQueryClient()
  const settle = (agent: Agent) => {
    queryClient.setQueryData(agentsKeys.detail(agentId), agent)
    void queryClient.invalidateQueries({ queryKey: agentsKeys.list() })
  }
  const update = useMutation({ mutationFn: (fields: Partial<AgentForm>) => agentsApi.update(agentId, fields), onSuccess: settle })
  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => (enabled ? agentsApi.enable(agentId) : agentsApi.disable(agentId)),
    onSuccess: settle,
  })
  const archive = useMutation({ mutationFn: () => agentsApi.archive(agentId), onSuccess: settle })
  const runNow = useMutation({
    mutationFn: () => agentsApi.run(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentsKeys.runs(agentId) })
      void queryClient.invalidateQueries({ queryKey: agentsKeys.detail(agentId) })
    },
  })
  const cancelRun = useMutation({
    mutationFn: (runId: string) => agentsApi.cancelRun(agentId, runId),
    onSuccess: (run) => {
      queryClient.setQueryData(agentsKeys.run(agentId, run.run_id), run)
      void queryClient.invalidateQueries({ queryKey: agentsKeys.runs(agentId) })
    },
  })
  return { update, setEnabled, archive, runNow, cancelRun }
}

export function useCreateAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (fields: Partial<AgentForm>) => agentsApi.create(fields),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: agentsKeys.list() }) },
  })
}

export function useAgentRuns(agentId: string) {
  const enabled = useEnabled()
  return useQuery({
    queryKey: agentsKeys.runs(agentId),
    queryFn: () => agentsApi.listRuns(agentId),
    enabled,
    refetchInterval: (query) => (query.state.data?.items.some(isActiveRun) === true ? RUN_POLL_MS : false),
  })
}

export function useAgentRun(agentId: string, runId: string | null) {
  const enabled = useEnabled() && runId !== null
  return useQuery({
    queryKey: agentsKeys.run(agentId, runId ?? ''),
    queryFn: () => agentsApi.getRun(agentId, runId ?? ''),
    enabled,
    refetchInterval: (query) => (query.state.data !== undefined && isActiveRun(query.state.data) ? RUN_POLL_MS : false),
  })
}

/**
 * The run's event journal, polled incrementally (`?after=`) while the run is
 * active. Each fetch reads the cached journal and appends the new page, so the
 * query's data IS the merged journal; a status change triggers one more read
 * so the final events land.
 */
export function useRunEvents(agentId: string, run: AgentRun | undefined): RunEvent[] {
  const queryClient = useQueryClient()
  const runId = run?.run_id ?? ''
  const active = run !== undefined && isActiveRun(run)
  const queryKey = [...agentsKeys.run(agentId, runId), 'events'] as const
  const { data, refetch } = useQuery({
    queryKey,
    queryFn: async (): Promise<{ events: RunEvent[]; after: number }> => {
      const known = queryClient.getQueryData<{ events: RunEvent[]; after: number }>(queryKey) ?? { events: [], after: 0 }
      const page = await agentsApi.listEvents(agentId, runId, known.after)
      return { events: mergeEvents(known.events, page.items), after: Math.max(known.after, page.nextAfter) }
    },
    enabled: runId !== '',
    refetchInterval: active ? RUN_POLL_MS : false,
  })
  const status = run?.status
  useEffect(() => {
    if (status !== undefined && runId !== '') void refetch()
  }, [status, runId, refetch])
  return data?.events ?? []
}
