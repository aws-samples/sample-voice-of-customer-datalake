/**
 * @fileoverview The setup guide's middle steps:
 *
 * - Understand the repository and Tenets (steps 1 and 2): their flows arrive in 7.52, so each says what it will do
 *   and offers Skip for now;
 * - Issue triage, Bug fixer and Feature builder (steps 3 to 5): the seeded automation found for the step as its row
 *   on Automations (7.52.00 C1: its state chip, "N to fix", its one action, here the step's primary, and its ⋯; Set
 *   up opens the Set up drawer), and its readiness open, "for <automation>, once set up", each check with its fix
 *   and doc link, asked as the guide's facts ask it (setupGuideRules.ts `guideSubject`: the deployment's only
 *   connection while it names none). An automation not found says why.
 *
 * @module pages/Agents/SetupGuide/AutomationSteps
 */
import { useTranslation } from 'react-i18next'
import { Clock } from 'lucide-react'
import { ReadinessSection } from '../ReadinessChecks'
import { AutomationRow } from '../Automations/AutomationRow'
import { useAutomationFacts } from '../Automations/useAutomationFacts'
import { guideSubject } from './setupGuideRules'
import type { Agent } from '../../../api/agentsApi'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'
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
export function AutomationStepBody({ step, agent, connections }: Readonly<{
  step: AutomationStep; agent: Agent | null; connections: readonly EngineeringConnection[]
}>) {
  const { t } = useTranslation('agents')
  const facts = useAutomationFacts(true)
  if (agent === null) {
    return <p className="rounded-md border border-border p-3 text-sm text-muted">{t(`setupGuide.automation.missing.${step}`)}</p>
  }
  return (
    <div className="space-y-3">
      <ul role="list" className="card p-0 overflow-hidden" aria-label={agent.name}>
        <AutomationRow agent={agent} isAdmin facts={facts} emphasis="primary" />
      </ul>
      {!agent.enabled && (
        <ReadinessSection subject={guideSubject(agent, connections)} enabled
          title={t('setupGuide.readinessFor', { name: agent.name })} />
      )}
    </div>
  )
}
