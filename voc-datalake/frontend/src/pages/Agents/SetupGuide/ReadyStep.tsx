/**
 * @fileoverview Step 6 of the setup guide, Ready to go: where each step stands, **Run on an issue now** (a Run now of
 * the Issue triage automation, else the Bug fixer, on one issue of its repository: the confirmation agents' Run now
 * uses, RunNowConfirm.tsx), that every run learns and its proposals wait in Skills for an administrator, and
 * **Finish the guide** (saved as the last step done; the guide stays one click away on the Agents page).
 *
 * @module pages/Agents/SetupGuide/ReadyStep
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, Play } from 'lucide-react'
import { agentPath, agentsPath } from '../agentsPaths'
import { EngineeringStartError } from '../EngineeringStartError'
import { RunNowConfirm } from '../RunNowConfirm'
import { useAgentMutations } from '../useAgents'
import { GUIDE_STEPS, issueRunner } from './setupGuideRules'
import { setupGuidePath } from './setupGuidePaths'
import { StepStatusBadge } from './StepNav'
import { useSaveProgress } from './useSetupGuide'
import type { Agent, RunNowBody } from '../../../api/agentsApi'
import type { SetupProgress } from '../../../api/engineeringSetupApi'
import type { Automations, StepStatuses } from './setupGuideRules'

function Summary({ statuses }: Readonly<{ statuses: StepStatuses }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-text-strong">{t('setupGuide.ready.summaryTitle')}</h3>
      <ul className="divide-y divide-border rounded-md border border-border">
        {GUIDE_STEPS.filter((step) => step !== 'ready').map((step) => (
          <li key={step} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <Link className="link" to={setupGuidePath(step)}>{t(`setupGuide.steps.${step}.title`)}</Link>
            <StepStatusBadge status={statuses[step]} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function RunOnIssue({ agent }: Readonly<{ agent: Agent }>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const { runNow } = useAgentMutations(agent.agent_id)
  const [confirming, setConfirming] = useState(false)
  const start = (body?: RunNowBody) => runNow.mutate(body, {
    onSuccess: () => { void navigate(agentPath(agent.agent_id, 'runs')) },
    onSettled: () => setConfirming(false),
  })
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted">{t('setupGuide.ready.runHint', { name: agent.name })}</p>
      <button type="button" className="btn btn-primary btn-sm" disabled={runNow.isPending}
        onClick={() => { runNow.reset(); setConfirming(true) }}>
        {runNow.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        {t('setupGuide.ready.run')}
      </button>
      {runNow.isError && <EngineeringStartError error={runNow.error} />}
      {confirming && <RunNowConfirm agent={agent} starting={runNow.isPending} onConfirm={start} onCancel={() => setConfirming(false)} />}
    </div>
  )
}

function Finish({ progress, finished }: Readonly<{ progress: SetupProgress; finished: boolean }>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const save = useSaveProgress()
  if (finished) return <p role="status" className="text-sm text-muted">{t('setupGuide.ready.finished')}</p>
  return (
    <div className="space-y-1">
      <button type="button" className="btn btn-secondary btn-sm" disabled={save.isPending}
        onClick={() => save.mutate({ revision: progress.revision, steps: { ready: 'done' } }, {
          onSuccess: () => { void navigate(agentsPath({ view: 'agents' })) },
        })}>
        {save.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
        {t('setupGuide.ready.finish')}
      </button>
      {save.isError && <p role="alert" className="text-[12px] text-danger">{t('setupGuide.saveFailed')}</p>}
    </div>
  )
}

export function ReadyStep({ statuses, automations, progress }: Readonly<{
  statuses: StepStatuses; automations: Automations; progress: SetupProgress
}>) {
  const { t } = useTranslation('agents')
  const runner = issueRunner(automations)
  return (
    <div className="space-y-4">
      <Summary statuses={statuses} />
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-text-strong">{t('setupGuide.ready.runTitle')}</h3>
        {runner === null ? <p className="text-sm text-muted">{t('setupGuide.ready.runNone')}</p> : <RunOnIssue agent={runner} />}
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-text-strong">{t('setupGuide.ready.learnTitle')}</h3>
        <p className="text-sm text-muted max-w-prose">{t('setupGuide.ready.learn')}</p>
        <Link className="link text-sm" to={agentsPath({ view: 'skills' })}>{t('setupGuide.ready.openSkills')}</Link>
      </div>
      <Finish progress={progress} finished={statuses.ready === 'done'} />
    </div>
  )
}
