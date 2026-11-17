/**
 * @fileoverview Agents → Setup guide (`/agents/setup[/<step>]`, 7.50.00; docs/autonomous-agents.md "Setup guide"):
 * the administrators' walk through the deployment's autonomous bug loop, in the owner's recommended order:
 *
 * 0. Prerequisites: GitHub connected with the deployment's GitHub App, the repository's CI attested, its issues
 *    ingested deployment-wide with the `voc-agent` label;
 * 1. Understand the repository and 2. Tenets (7.52.00): the repository's knowledge pack to compare and approve, and its
 *    tenets drafts to accept or reject, each then opened as a pull request (Knowledge/RepositoryReviewStep.tsx);
 * 3. Issue triage, 4. Bug fixer, 5. Feature builder: each seeded automation set up and enabled, its readiness shown;
 * 6. Ready to go: the summary, Run on an issue now, every run learns (proposals wait in Skills).
 *
 * Every step can be skipped for now, with a plain warning of what skipping costs; none is ever locked
 * (setupGuideRules.ts). The guide reads only existing routes and its own progress (useSetupGuide.ts); the address
 * names the step (setupGuidePaths.ts), and `/agents/setup` opens the step it recommends. Administrators only, where the
 * engineering agents are on.
 *
 * @module pages/Agents/SetupGuide/SetupGuide
 */
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { useIsAdmin } from '../../../store/authStore'
import { isEngineeringAvailable } from '../../../runtimeConfig'
import { useReplaceAddress } from '../../../utils/pathPlace'
import { BackToAgents } from '../BackToAgents'
import { RepositoryReviewStep } from '../Knowledge/RepositoryReviewStep'
import { AutomationStepBody } from './AutomationSteps'
import { PrerequisitesStep } from './PrerequisitesStep'
import { ReadyStep } from './ReadyStep'
import { isAutomationStep, recommendedGuideStep } from './setupGuideRules'
import { readSetupGuideAddress } from './setupGuidePaths'
import { StepFrame } from './StepFrame'
import { StepNav } from './StepNav'
import { useSetupGuide } from './useSetupGuide'
import type { SetupProgress, SetupStepId } from '../../../api/engineeringSetupApi'
import type { Automations, GuideFacts, StepStatuses } from './setupGuideRules'

function StepBody({ step, facts, automations, statuses, progress }: Readonly<{
  step: SetupStepId; facts: GuideFacts; automations: Automations; statuses: StepStatuses; progress: SetupProgress
}>) {
  if (step === 'prerequisites') return <PrerequisitesStep facts={facts} />
  if (isAutomationStep(step)) return <AutomationStepBody step={step} agent={automations[step]} connections={facts.connections} />
  if (step === 'ready') return <ReadyStep statuses={statuses} automations={automations} progress={progress} />
  return <RepositoryReviewStep kind={step === 'understand' ? 'knowledge' : 'tenets'} connections={facts.connections} />
}

function Guide({ requested }: Readonly<{ requested: SetupStepId | null }>) {
  const { t } = useTranslation('agents')
  const guide = useSetupGuide(true)
  const { facts, statuses, progress } = guide
  if (guide.failed) return <LoadFailed message={t('setupGuide.loadFailed')} onRetry={guide.retry} retrying={guide.loading} />
  if (facts === undefined || statuses === undefined || progress === undefined) {
    return <div className="skeleton h-48" role="status" aria-label={t('setupGuide.loading')} />
  }
  const step = requested ?? recommendedGuideStep(statuses)
  return (
    <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
      <StepNav statuses={statuses} open={step} />
      <StepFrame step={step} statuses={statuses} progress={progress}>
        <StepBody step={step} facts={facts} automations={guide.automations} statuses={statuses} progress={progress} />
      </StepFrame>
    </div>
  )
}

export default function SetupGuide() {
  const { t } = useTranslation('agents')
  const isAdmin = useIsAdmin()
  const read = readSetupGuideAddress(useLocation())
  useReplaceAddress(read?.replaceWith ?? null)
  const available = isAdmin && isEngineeringAvailable()
  return (
    <div className="space-y-4 sm:space-y-6">
      <BackToAgents />
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('setupGuide.title')}</h1>
        <p className="text-sm text-muted mt-1 max-w-prose">{t('setupGuide.subtitle')}</p>
      </div>
      {available
        ? <Guide requested={read?.place ?? null} />
        : <p className="card p-6 text-center text-sm text-muted">{t('setupGuide.notAvailable')}</p>}
    </div>
  )
}
