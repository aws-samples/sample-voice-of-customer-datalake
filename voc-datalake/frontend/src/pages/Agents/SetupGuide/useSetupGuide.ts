/**
 * @fileoverview The setup guide's reads and its one write (7.50.00). It reads only routes that already serve the
 * deployment (the agents list, the repository connections, the GitHub Apps, each found automation's readiness) and its
 * own progress (`GET /agents/engineering/setup`), and writes only that progress (`PUT`): a step skipped or taken
 * back, the guide finished, the first visit's choice. Every rule on what it read is setupGuideRules.ts's.
 *
 * @module pages/Agents/SetupGuide/useSetupGuide
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../../api/engineeringConnectionsApi'
import { engineeringSetupApi, engineeringSetupKeys } from '../../../api/engineeringSetupApi'
import { githubAppsApi, githubAppsKeys } from '../../../api/githubAppsApi'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { useConfigStore } from '../../../store/configStore'
import { useAgentList } from '../useAgents'
import { useReadiness } from '../useReadiness'
import { findAutomations, stepStatuses } from './setupGuideRules'
import type { Agent } from '../../../api/agentsApi'
import type { ConnectionList } from '../../../api/engineeringConnectionsApi'
import type { ReadinessCheck } from '../../../api/engineeringReadinessApi'
import type { SetupChange, SetupProgress } from '../../../api/engineeringSetupApi'
import type { GitHubAppList } from '../../../api/githubAppsApi'
import type { Automations, GuideFacts, StepStatuses } from './setupGuideRules'

/** The guide's progress (what a person chose), read while `enabled`. */
export function useSetupProgress(enabled: boolean) {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return useQuery({ queryKey: engineeringSetupKeys.progress(), queryFn: engineeringSetupApi.get, enabled: enabled && configured })
}

/** Save a change of the progress from the revision read; a 409 (another administrator saved meanwhile) reads it again. */
export function useSaveProgress() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (change: SetupChange) => engineeringSetupApi.save(change),
    onSuccess: (saved: SetupProgress) => { queryClient.setQueryData(engineeringSetupKeys.progress(), saved) },
    onError: (error) => {
      if (apiErrorStatus(error) === 409) void queryClient.invalidateQueries({ queryKey: engineeringSetupKeys.progress() })
    },
  })
}

export interface GuideState {
  readonly facts: GuideFacts | undefined
  readonly automations: Automations
  readonly progress: SetupProgress | undefined
  readonly statuses: StepStatuses | undefined
  readonly loading: boolean
  /** A read failed: the guide says so and offers to read again. */
  readonly failed: boolean
  readonly retry: () => void
}

/** The readiness of one automation found (none read for an automation not found). */
function useAutomationReadiness(agent: Agent | null, enabled: boolean): readonly ReadinessCheck[] | undefined {
  return useReadiness({ automation: agent?.agent_id ?? '' }, enabled && agent !== null).data
}

/** The facts, once the agents, the connections and the Apps are read (the readiness follows as it comes). */
function factsOf(agents: readonly Agent[] | undefined, connections: ConnectionList | undefined, apps: GitHubAppList | undefined,
  readiness: GuideFacts['readiness']): GuideFacts | undefined {
  if (agents === undefined || connections === undefined || apps === undefined) return undefined
  return { agents, connections: connections.connections, apps: apps.apps.length, readiness }
}

/** Everything the guide shows, read while `enabled` (an administrator, with the engineering agents on). */
export function useSetupGuide(enabled: boolean): GuideState {
  const agents = useAgentList()
  const connections = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list, enabled })
  const apps = useQuery({ queryKey: githubAppsKeys.list(), queryFn: githubAppsApi.list, enabled, retry: false })
  const progress = useSetupProgress(enabled)
  const automations = findAutomations(agents.data ?? [])
  const readiness = {
    triage: useAutomationReadiness(automations.triage, enabled),
    bug_fixer: useAutomationReadiness(automations.bug_fixer, enabled),
    feature_builder: useAutomationReadiness(automations.feature_builder, enabled),
  }
  const reads = [agents, connections, apps, progress]
  const facts = factsOf(agents.data, connections.data, apps.data, readiness)
  return {
    facts,
    automations,
    progress: progress.data,
    statuses: facts !== undefined && progress.data !== undefined ? stepStatuses(facts, progress.data) : undefined,
    loading: reads.some((read) => read.isLoading),
    failed: reads.some((read) => read.isError),
    retry: () => { reads.filter((read) => read.isError).forEach((read) => { void read.refetch() }) },
  }
}
