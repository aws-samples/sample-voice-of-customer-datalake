/**
 * @fileoverview One step of the setup guide, framed: its number, title and status, what it does, its body, then what
 * skipping it costs and where it sits in the recommended order, with **Skip for now** (or taking a skip back) and the
 * way to the next step. A skip is never a lock: it is saved as the person's choice (`PUT /agents/engineering/setup`),
 * and a step found done later is done whatever was chosen.
 *
 * @module pages/Agents/SetupGuide/StepFrame
 */
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { GUIDE_STEPS, canSkip, nextOpenStep, notDoneBefore } from './setupGuideRules'
import { setupGuidePath } from './setupGuidePaths'
import { useSaveProgress } from './useSetupGuide'
import { StepStatusBadge } from './StepNav'
import type { ReactNode } from 'react'
import type { SetupProgress, SetupStepId } from '../../../api/engineeringSetupApi'
import type { StepStatuses } from './setupGuideRules'

/** What skipping the step costs, and the steps the recommended order would have had first. */
function SkipCost({ step, statuses }: Readonly<{ step: SetupStepId; statuses: StepStatuses }>) {
  const { t } = useTranslation('agents')
  const before = notDoneBefore(step, statuses)
  return (
    <div className="rounded-md border border-warn/30 bg-warn-subtle p-3 space-y-1">
      <p className="flex items-center gap-2 text-sm font-semibold text-text-strong">
        <AlertTriangle size={14} className="text-warn" aria-hidden="true" /> {t('setupGuide.skipCostTitle')}
      </p>
      <p className="text-sm text-text">{t(`setupGuide.steps.${step}.skipCost`)}</p>
      <p className="text-[12px] text-muted">
        {t('setupGuide.order')}{' '}
        {before.length === 0
          ? t('setupGuide.orderFine')
          : t('setupGuide.orderMissing', { list: before.map((id) => t(`setupGuide.steps.${id}.title`)).join(', ') })}
      </p>
    </div>
  )
}

/** Skip for now, or take a skip back; a save refused because the guide moved says so (it is read again). */
function SkipControl({ step, statuses, progress }: Readonly<{ step: SetupStepId; statuses: StepStatuses; progress: SetupProgress }>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const save = useSaveProgress()
  const skipped = statuses[step] === 'skipped'
  const choose = () => {
    save.mutate({ revision: progress.revision, steps: { [step]: skipped ? 'pending' : 'skipped' } }, {
      // (a skip moves on to the next step still open; taking one back stays on it)
      onSuccess: () => { if (!skipped) void navigate(setupGuidePath(nextOpenStep(step, statuses))) },
    })
  }
  if (!skipped && !canSkip(step, statuses[step])) return null
  return (
    <div className="space-y-1">
      <button type="button" className="btn btn-secondary btn-sm" disabled={save.isPending} onClick={choose}>
        {save.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
        {skipped ? t('setupGuide.unskip') : t('setupGuide.skip')}
      </button>
      {save.isError && (
        <p role="alert" className="text-[12px] text-danger">
          {apiErrorStatus(save.error) === 409 ? t('setupGuide.saveConflict') : t('setupGuide.saveFailed')}
        </p>
      )}
    </div>
  )
}

function NextLink({ step }: Readonly<{ step: SetupStepId }>) {
  const { t } = useTranslation('agents')
  const next = GUIDE_STEPS[GUIDE_STEPS.indexOf(step) + 1]
  if (next === undefined) return null
  return (
    <Link className="btn btn-ghost btn-sm" to={setupGuidePath(next)}>
      {t('setupGuide.next', { step: t(`setupGuide.steps.${next}.title`) })} <ArrowRight size={14} aria-hidden="true" />
    </Link>
  )
}

export function StepFrame({ step, statuses, progress, children }: Readonly<{
  step: SetupStepId; statuses: StepStatuses; progress: SetupProgress; children: ReactNode
}>) {
  const { t } = useTranslation('agents')
  const titleId = `setup-step-${step}`
  const status = statuses[step]
  return (
    <section aria-labelledby={titleId} className="card p-4 space-y-4" data-testid="setup-step" data-step={step}>
      <header className="space-y-1">
        <p className="text-[12px] text-muted">{t('setupGuide.stepNumber', { n: GUIDE_STEPS.indexOf(step) })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={titleId} className="text-lg font-semibold text-text-strong">{t(`setupGuide.steps.${step}.title`)}</h2>
          <StepStatusBadge status={status} />
        </div>
        <p className="text-sm text-muted max-w-prose">{t(`setupGuide.steps.${step}.summary`)}</p>
      </header>
      {children}
      {step !== 'ready' && status !== 'done' && <SkipCost step={step} statuses={statuses} />}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <SkipControl step={step} statuses={statuses} progress={progress} />
        <NextLink step={step} />
      </div>
    </section>
  )
}
