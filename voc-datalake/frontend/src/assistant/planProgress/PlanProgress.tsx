/**
 * @fileoverview A running plan's progress (docs/assistant-plan-mode.md → "UI"):
 * goal and status, the steps with their statuses, an inline approval for a step
 * that needs one, Cancel while it can still stop, the summary when it ends and
 * a link to the project it created. Shown in the assistant bubble under an
 * approved `propose_plan`, and on the Agents page's Plans list.
 *
 * @module assistant/planProgress/PlanProgress
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ListChecks } from 'lucide-react'
import { isTerminalPlan } from '../../api/plansApi'
import { PlanStatusBadge } from './PlanBadges'
import { PlanStepRow } from './PlanStepRow'
import { usePlanProgress } from './usePlanProgress'
import { createdProjectId } from './planIds'
import type { PlanView } from '../../api/plansApi'
import type { StepDecision } from './usePlanProgress'

function PlanFooter({ plan, cancelling, onCancel }: Readonly<{ plan: PlanView; cancelling: boolean; onCancel: () => void }>) {
  const { t } = useTranslation('assistant')
  const projectId = createdProjectId(plan)
  const terminal = isTerminalPlan(plan.status)
  if (!terminal) {
    return (
      <div className="flex justify-end">
        <button type="button" className="btn btn-danger btn-sm" disabled={cancelling} onClick={onCancel}>{t('plan.cancel')}</button>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      {plan.summary !== undefined && plan.summary !== '' && <p className="text-[13px] text-text">{plan.summary}</p>}
      {projectId !== undefined && <Link className="link text-[13px]" to={`/projects/${projectId}`}>{t('plan.openProject')}</Link>}
    </div>
  )
}

function PlanBody({ plan, busy, cancelling, onCancel, onResolve }: Readonly<{
  plan: PlanView
  busy: boolean
  cancelling: boolean
  onCancel: () => void
  onResolve: (decision: StepDecision) => void
}>) {
  const { t } = useTranslation('assistant')
  const numbers = new Map(plan.steps.map((step, index) => [step.id, index + 1]))
  return (
    <>
      <div className="flex items-start gap-2">
        <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-[13px] font-medium text-text-strong">{plan.goal}</p>
        <PlanStatusBadge status={plan.status} />
      </div>
      <ol className="divide-y divide-border" aria-label={t('plan.steps')}>
        {plan.steps.map((step, index) => (
          <PlanStepRow key={step.id} step={step} index={index} numberOf={(id) => numbers.get(id)} busy={busy} onResolve={onResolve} />
        ))}
      </ol>
      <PlanFooter plan={plan} cancelling={cancelling} onCancel={onCancel} />
    </>
  )
}

export default function PlanProgress({ planId, onOpen }: Readonly<{ planId: string; onOpen: () => void }>) {
  const { t } = useTranslation('assistant')
  const { query, cancel, resolveStep } = usePlanProgress(planId, { onOpen })
  const failedAction = cancel.isError || resolveStep.isError
  return (
    <section className="card space-y-2 p-3" aria-label={t('plan.title')} data-testid="plan-progress" data-plan-id={planId}>
      {query.data === undefined && !query.isError && <div className="skeleton h-10" aria-label={t('plan.loading')} />}
      {query.data === undefined && query.isError && <p role="alert" className="text-[12px] text-danger">{t('plan.loadFailed')}</p>}
      {query.data !== undefined && (
        <PlanBody
          plan={query.data}
          busy={resolveStep.isPending}
          cancelling={cancel.isPending}
          onCancel={() => cancel.mutate()}
          onResolve={(decision) => resolveStep.mutate(decision)}
        />
      )}
      {failedAction && <p role="alert" className="text-[12px] text-danger">{t('plan.actionFailed')}</p>}
    </section>
  )
}
