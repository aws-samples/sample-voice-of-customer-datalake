/**
 * @fileoverview What the automations' states and activity stand on, read once for every row (7.52.00 C1; ux-agents-redesign
 * part 1 §2.3): the deployment's repository connections and the flows' monthly budgets (an engineering automation's
 * rules 1 to 4, automationState.ts), and this month's spend by flow (the Usage cell's "$1.20 of $50", one
 * `GET /agents/engineering/spend?by=workflow` read whose groups are keyed by the flow's id). Each is the cache entry
 * the Connections, Flows and Spend tabs read too. The engineering reads are an administrator's, while the engineering
 * agents are on; a person who is not one gets no engineering facts (the rows show the `enabled` flag's state).
 *
 * @module pages/Agents/Automations/useAutomationFacts
 */
import { useQuery } from '@tanstack/react-query'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../../api/engineeringConnectionsApi'
import { currentMonth, engineeringSpendApi, engineeringSpendKeys } from '../../../api/engineeringSpendApi'
import { workflowsApi, workflowsKeys } from '../../../api/workflowsApi'
import { isEngineeringAvailable } from '../../../runtimeConfig'
import { useConfigStore } from '../../../store/configStore'
import type { Agent } from '../../../api/agentsApi'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'
import type { WorkflowSummary } from '../../../api/workflowsApi'
import type { EngineeringRead } from './automationState'

export interface AutomationFacts {
  /** The engineering facts of `agent`'s rules (automationState.ts). */
  readonly engineeringOf: (agent: Pick<Agent, 'workflow_id'>) => EngineeringRead
  /** This month's spend of `agent`'s flow in dollars, and its flow's monthly budget; null when not known. */
  readonly spendOf: (agent: Pick<Agent, 'workflow_id'>) => { readonly usd: number | null; readonly budget: number | null }
  /** The deployment's connections once read (an administrator's). */
  readonly connections: readonly EngineeringConnection[] | undefined
  /** Whether the engineering reads are made here (an administrator, with the engineering agents on). */
  readonly reads: boolean
}

/** The flows by id (the library's list). */
function useFlows(enabled: boolean): { flows: ReadonlyMap<string, WorkflowSummary> | undefined; failed: boolean } {
  const read = useQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list, enabled, staleTime: 30_000 })
  return { flows: read.data === undefined ? undefined : new Map(read.data.map((flow) => [flow.workflow_id, flow])), failed: read.isError }
}

/** This month's spend by flow (a failed read: none known, the cell says "—"). */
function useSpendByFlow(enabled: boolean): ReadonlyMap<string, number> | undefined {
  const query = { month: currentMonth(), by: 'workflow' as const, workflow: '' }
  const read = useQuery({ queryKey: engineeringSpendKeys.month(query), queryFn: () => engineeringSpendApi.month(query), enabled, retry: false })
  return read.data === undefined ? undefined : new Map(read.data.groups.map((group) => [group.key, group.usd]))
}

/** Where the engineering reads stand; `failed` too when they are not made here (the engineering agents are off, or
 * this is not an administrator's page). */
function readState({ reads, failed, read }: Readonly<{ reads: boolean; failed: boolean; read: boolean }>): EngineeringRead['state'] {
  if (failed || !reads) return 'failed'
  return read ? 'ready' : 'loading'
}

/** The facts every automation row reads (module doc), for an administrator (`isAdmin`). */
export function useAutomationFacts(isAdmin: boolean): AutomationFacts {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const reads = configured && isAdmin && isEngineeringAvailable()
  const connectionsRead = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list, enabled: reads })
  const { flows, failed: flowsFailed } = useFlows(configured && isAdmin)
  const spend = useSpendByFlow(reads)
  const connections = connectionsRead.data?.connections
  const state = readState({ reads, failed: connectionsRead.isError || flowsFailed, read: connections !== undefined && flows !== undefined })
  // (the list's entries are the server's as sent, only checked against the schema: a budget is a positive number, else none)
  const budgetOf = (workflowId: string | null): number | null => {
    const budget: unknown = workflowId === null ? null : flows?.get(workflowId)?.monthly_budget_usd
    return typeof budget === 'number' && budget > 0 ? budget : null
  }
  // (a flow with no group spent nothing this month; unknown while the spend is not read)
  const usdOf = (workflowId: string | null): number | null => {
    if (workflowId === null || spend === undefined) return null
    return spend.get(workflowId) ?? 0
  }
  return {
    engineeringOf: ({ workflow_id: workflowId }) => ({ state, connections: connections ?? [], budget: budgetOf(workflowId) }),
    spendOf: ({ workflow_id: workflowId }) => ({ usd: usdOf(workflowId), budget: budgetOf(workflowId) }),
    connections,
    reads,
  }
}
