/**
 * @fileoverview The autonomous agents whose last run is waiting for a person
 * (`stats.last_run_status === 'needs_human'`): the sidebar's count on
 * "Autonomous agents" and Home's decision cards. Both read the same `/agents`
 * query as the agents list (one cache entry), only when enabled, refreshed once
 * a minute.
 *
 * @module hooks/useAgentsNeedingDecision
 */
import { useQuery } from '@tanstack/react-query'
import { agentsApi, agentsKeys } from '../api/agentsApi'
import type { Agent } from '../api/agentsApi'

/** How often the sidebar (and Home) re-read the agents list. */
const AGENTS_ATTENTION_POLL_MS = 60_000

const NO_AGENTS: readonly Agent[] = []

/** The agents waiting for a decision, in list order (none while disabled). */
export function useAgentsAwaitingDecision(enabled: boolean): readonly Agent[] {
  const { data } = useQuery({
    queryKey: agentsKeys.list(),
    queryFn: agentsApi.list,
    enabled,
    refetchInterval: enabled ? AGENTS_ATTENTION_POLL_MS : false,
  })
  return enabled ? (data ?? NO_AGENTS).filter((agent) => agent.stats.last_run_status === 'needs_human') : NO_AGENTS
}

export function useAgentsNeedingDecision(enabled: boolean): number {
  return useAgentsAwaitingDecision(enabled).length
}
