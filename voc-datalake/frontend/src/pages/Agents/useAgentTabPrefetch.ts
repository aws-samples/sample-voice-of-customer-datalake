/**
 * @fileoverview Warms each agent tab's data before it is opened.
 *
 * Live finding: the first switch to a tab showed an empty skeleton for more than a
 * second while its queries started. The tabs' reads (the runs list, the agent's
 * workflow, the workflow library, the model settings, the project list) are
 * prefetched under the SAME keys the tabs read — once the browser is idle after the
 * agent loads, and again on hover / focus of a tab — so the switch renders from cache.
 * A prefetch younger than `PREFETCH_FRESH_MS` is not repeated.
 *
 * @module pages/Agents/useAgentTabPrefetch
 */
import { useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { agentsApi, agentsKeys } from '../../api/agentsApi'
import { api } from '../../api/client'
import { projectsApi } from '../../api/projectsApi'
import { projectsKey } from '../../api/projectQueryKeys'
import { DEFAULT_WORKFLOW_ID, workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import type { QueryClient } from '@tanstack/react-query'
import { modelSettingsKey } from '../../api/queryKeys'
import { noCleanup } from '../../hooks/noCleanup'

/** How long after the agent loads the idle prefetch waits (lets the first paint settle). */
const IDLE_PREFETCH_MS = 400
/** A hover within this long of the last fetch reads the cache, not the network. */
const PREFETCH_FRESH_MS = 30_000

interface Target {
  readonly agentId: string
  readonly workflowId: string
  readonly isAdmin: boolean
}

type Prefetch = (client: QueryClient, target: Target) => Promise<unknown>

const workflowDetail: Prefetch = (client, { workflowId }) => client.prefetchQuery({
  queryKey: workflowsKeys.detail(workflowId), queryFn: () => workflowsApi.get(workflowId), staleTime: PREFETCH_FRESH_MS,
})
const workflowList = (client: QueryClient) => client.prefetchQuery({
  queryKey: workflowsKeys.list(), queryFn: workflowsApi.list, staleTime: PREFETCH_FRESH_MS,
})

const PREFETCH: Readonly<Record<string, Prefetch>> = {
  runs: (client, target) => Promise.all([
    client.prefetchQuery({ queryKey: agentsKeys.runs(target.agentId), queryFn: () => agentsApi.listRuns(target.agentId), staleTime: PREFETCH_FRESH_MS }),
    workflowDetail(client, target),
  ]),
  workflow: (client, target) => Promise.all([workflowDetail(client, target), target.isAdmin ? workflowList(client) : null]),
  settings: (client) => workflowList(client),
  personas: (client) => client.prefetchQuery({ queryKey: projectsKey(), queryFn: projectsApi.getProjects, staleTime: PREFETCH_FRESH_MS }),
  models: (client) => client.prefetchQuery({
    queryKey: modelSettingsKey(), queryFn: () => api.getModelSettings(), retry: false, staleTime: PREFETCH_FRESH_MS,
  }),
}

/** `prefetch(tab)` for hover / focus, plus one idle pass over every tab once the agent is known. */
export function useAgentTabPrefetch(
  agent: { readonly agent_id: string; readonly workflow_id: string | null } | undefined,
  isAdmin: boolean,
): (tab: string) => void {
  const client = useQueryClient()
  const agentId = agent?.agent_id
  const workflowId = agent?.workflow_id ?? DEFAULT_WORKFLOW_ID
  const prefetch = useCallback((tab: string) => {
    const run = PREFETCH[tab]
    if (agentId !== undefined && run !== undefined) void run(client, { agentId, workflowId, isAdmin })
  }, [agentId, workflowId, client, isAdmin])
  useEffect(() => {
    if (agentId === undefined) return noCleanup
    const timer = setTimeout(() => Object.keys(PREFETCH).forEach(prefetch), IDLE_PREFETCH_MS)
    return () => clearTimeout(timer)
  }, [agentId, prefetch])
  return prefetch
}
