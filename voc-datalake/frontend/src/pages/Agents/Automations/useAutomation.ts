/**
 * @fileoverview One automation's state and actions, as its row on Automations and its page's header show them (7.52.00
 * C1): its readiness while it is off (an engineering automation's, an administrator's), its state (automationState.ts)
 * from the facts every row shares (useAutomationFacts.ts), and its actions (useAutomationActions.tsx).
 *
 * @module pages/Agents/Automations/useAutomation
 */
import { useNavigate } from 'react-router-dom'
import { isEngineeringAgent } from '../../../api/agentsApi'
import { agentsPath } from '../agentsPaths'
import { usableConnections } from '../engineeringAgentRules'
import { useReadiness } from '../useReadiness'
import { automationState } from './automationState'
import { useAutomationActions } from './useAutomationActions'
import { useAutomationFacts } from './useAutomationFacts'
import type { Agent } from '../../../api/agentsApi'
import type { AutomationState } from './automationState'
import type { AutomationActions } from './useAutomationActions'
import type { Removal } from './AutomationDialogs'
import type { AutomationFacts } from './useAutomationFacts'

export interface AutomationView {
  readonly state: AutomationState
  readonly actions: AutomationActions
}

/** The state and actions of `agent`, from the shared `facts`; `removal`: the list's Delete or the page's Archive. */
export function useAutomation(agent: Agent, isAdmin: boolean, facts: AutomationFacts, { removal, onRemoved }: Readonly<{
  removal: Removal; onRemoved?: () => void
}>): AutomationView {
  const checks = useReadiness({ automation: agent.agent_id }, facts.reads && isEngineeringAgent(agent) && !agent.enabled)
  const state = automationState({ agent, isAdmin, engineering: facts.engineeringOf(agent), checks: checks.data })
  // (a Fix opens the drawer while a connection it can use is left, else Connections)
  const connectionUsable = facts.connections !== undefined && usableConnections(agent, facts.connections).length > 0
  const actions = useAutomationActions(agent, { removal, connectionUsable, onRemoved })
  return { state, actions }
}

/** The automation page's header: its own facts, Archive, and the list once it is archived. */
export function useAutomationHeader(agent: Agent, isAdmin: boolean): AutomationView {
  const navigate = useNavigate()
  const facts = useAutomationFacts(isAdmin)
  return useAutomation(agent, isAdmin, facts, { removal: 'archive', onRemoved: () => { void navigate(agentsPath({ view: 'agents' })) } })
}
