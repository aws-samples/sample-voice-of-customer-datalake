/**
 * @fileoverview The rules of an engineering agent's page (7.47.00), as the server holds them
 * (`lambda/api/agents_handler.py` `_check_engineering`): it is enabled only once it has a stored connection (a GitHub
 * one with a GitHub issue trigger), a language and its flow's monthly budget; a PRD is handed only to an enabled
 * feature agent.
 *
 * @module pages/Agents/engineeringAgentRules
 */
import type { Agent } from '../../api/agentsApi'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'

/** What an engineering agent still needs before it can be enabled. */
export type Readiness = 'ready' | 'no_connection' | 'set_up'

/** The connections the agent may use: GitHub ones only when it has a GitHub issue trigger. */
export function usableConnections(agent: Pick<Agent, 'triggers'>, connections: readonly EngineeringConnection[]):
  EngineeringConnection[] {
  const issues = agent.triggers.some((trigger) => trigger.kind === 'github_issue')
  return connections.filter((connection) => !issues || connection.host === 'github')
}

/** Ready (its stored connection, its language, its flow's monthly budget), no connection it can use, or to set up. */
export function readinessOf(agent: Pick<Agent, 'engineering' | 'triggers'>, connections: readonly EngineeringConnection[],
  budget: number | null): Readiness {
  const connection = agent.engineering?.connection ?? null
  const language = agent.engineering?.language ?? null
  const stored = connection !== null && connections.some((entry) => entry.connection_id === connection)
  if (stored && language !== null && budget !== null) return 'ready'
  return usableConnections(agent, connections).length === 0 ? 'no_connection' : 'set_up'
}

/** The agents a PRD can be handed to: enabled, active engineering agents that build features. */
export function featureBuilders(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => agent.enabled && agent.status === 'active'
    && agent.engineering?.feedback_type === 'feature_request')
}
