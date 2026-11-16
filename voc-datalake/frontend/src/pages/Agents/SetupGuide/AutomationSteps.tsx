/**
 * @fileoverview The setup guide's middle steps:
 *
 * - Understand the repository and Tenets (steps 1 and 2): their flows arrive in 7.52, so each says what it will do
 *   and offers Skip for now;
 * - Issue triage, Bug fixer and Feature builder (steps 3 to 5): the seeded automation found for the step, its Set up
 *   and Enabled control as on its page (AgentEngineering.tsx: the Set up dialog, Enable waiting for the checks a run
 *   needs), and its readiness open, each check with its fix and doc link. An automation not found says why.
 *
 * @module pages/Agents/SetupGuide/AutomationSteps
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Clock } from 'lucide-react'
import { EngineeringEnableControl } from '../AgentEngineering'
import { ReadinessSection } from '../ReadinessChecks'
import { agentPath } from '../agentsPaths'
import type { Agent } from '../../../api/agentsApi'
import type { AutomationStep } from './setupGuideRules'

/** Steps 1 and 2, whose flows arrive in 7.52. */
export function LaterStep() {
  const { t } = useTranslation('agents')
  return (
    <p className="flex items-start gap-2 rounded-md border border-border bg-bg-accent p-3 text-sm text-text">
      <Clock size={16} className="mt-0.5 flex-shrink-0 text-muted" aria-hidden="true" /> {t('setupGuide.later')}
    </p>
  )
}

/** Steps 3 to 5: the automation found for `step`, or why none is. */
export function AutomationStepBody({ step, agent }: Readonly<{ step: AutomationStep; agent: Agent | null }>) {
  const { t } = useTranslation('agents')
  if (agent === null) {
    return <p className="rounded-md border border-border p-3 text-sm text-muted">{t(`setupGuide.automation.missing.${step}`)}</p>
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-text-strong break-words [overflow-wrap:anywhere]">{agent.name}</p>
          <Link className="link text-[12px]" to={agentPath(agent.agent_id)}>{t('setupGuide.automation.open', { name: agent.name })}</Link>
        </div>
        <EngineeringEnableControl agent={agent} isAdmin withReadiness={false} />
      </div>
      {!agent.enabled && <ReadinessSection subject={{ automation: agent.agent_id }} enabled />}
    </div>
  )
}
