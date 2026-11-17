/**
 * @fileoverview The setup guide's middle steps:
 *
 * - Issue triage, Bug fixer and Feature builder (steps 3 to 5): the seeded automation found for the step as its row
 *   on Automations (7.52.00 C1: its state chip, "N to fix", its one action, here the step's primary, and its ⋯; Set
 *   up opens the Set up drawer), and its readiness open, "for <automation>, once set up", each check with its fix
 *   and doc link, asked as the guide's facts ask it (setupGuideRules.ts `guideSubject`: the deployment's only
 *   connection while it names none). An automation not found says why.
 *
 * @module pages/Agents/SetupGuide/AutomationSteps
 */
import { useTranslation } from 'react-i18next'
import { ReadinessSection } from '../ReadinessChecks'
import { AutomationRow } from '../Automations/AutomationRow'
import { useAutomationFacts } from '../Automations/useAutomationFacts'
import { guideSubject } from './setupGuideRules'
import type { Agent } from '../../../api/agentsApi'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'
import type { AutomationStep } from './setupGuideRules'

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
