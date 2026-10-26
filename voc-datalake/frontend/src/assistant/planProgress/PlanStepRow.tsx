/**
 * @fileoverview One step of a running plan: number, title, page label, status;
 * its recorded outputs once done (ids; an analysis step's result as markdown), its error when it failed or
 * was skipped, and — while it needs approval — an inline approval: the tool's
 * title, why it stopped, the exact arguments it would write, Approve / Decline.
 * Approve sends back the fingerprint of exactly that write (the server refuses
 * it once the paused write has changed); without one only Decline is offered.
 *
 * @module assistant/planProgress/PlanStepRow
 */
import { useTranslation } from 'react-i18next'
import { DESTRUCTIVE_CLIENT_TOOLS } from '../contract'
import { FieldTable } from '../approvals/previews/FieldDiff'
import { planArgRows } from '../approvals/previews/planRows'
import { PlanStepStatusBadge } from './PlanBadges'
import { StepResult } from './StepResult'
import type { PlanPending, PlanStepView } from '../../api/plansApi'
import type { StepNumberOf } from '../approvals/previews/planRows'
import type { StepDecision } from './usePlanProgress'

const DESTRUCTIVE: ReadonlySet<string> = new Set(DESTRUCTIVE_CLIENT_TOOLS)

interface StepApprovalProps {
  pending: PlanPending
  numberOf: StepNumberOf
  busy: boolean
  onApprove: (fingerprint: string) => void
  onDecline: () => void
}

function StepApproval({ pending, numberOf, busy, onApprove, onDecline }: Readonly<StepApprovalProps>) {
  const { t } = useTranslation('assistant')
  const destructive = DESTRUCTIVE.has(pending.tool)
  const title = t(`assistantTools:tools.${pending.tool}.title`, { defaultValue: pending.tool })
  return (
    <div className="space-y-2 rounded-md border border-warn/30 bg-card p-2" data-testid="plan-step-approval">
      <p className="text-[13px] font-medium text-text-strong">{t('plan.approval.title', { tool: title })}</p>
      {pending.reason !== '' && <p className="text-[12px] text-text">{pending.reason}</p>}
      <FieldTable rows={planArgRows(pending.args, numberOf, t)} label={t('plan.approval.fields', { tool: title })} />
      {destructive && <p className="text-[12px] text-danger">{t('plan.approval.destructive')}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onDecline}>{t('plan.approval.decline')}</button>
        <button type="button" className={destructive ? 'btn btn-danger-solid btn-sm' : 'btn btn-primary btn-sm'} disabled={busy || pending.fingerprint === ''} onClick={() => onApprove(pending.fingerprint)}>
          {t('plan.approval.approve')}
        </button>
      </div>
    </div>
  )
}

function StepOutputs({ outputs }: Readonly<{ outputs: Record<string, string> }>) {
  const entries = Object.entries(outputs)
  if (entries.length === 0) return null
  return (
    <ul className="space-y-0.5 text-[12px] text-muted">
      {entries.map(([name, value]) => (
        <li key={name} className="break-words"><span className="font-mono">{name}</span>: <span className="text-text">{value}</span></li>
      ))}
    </ul>
  )
}

interface PlanStepRowProps {
  step: PlanStepView
  index: number
  numberOf: StepNumberOf
  busy: boolean
  onResolve: (decision: StepDecision) => void
}

export function PlanStepRow({ step, index, numberOf, busy, onResolve }: Readonly<PlanStepRowProps>) {
  const { t } = useTranslation('assistant')
  return (
    <li className="space-y-1.5 py-2" data-testid={`plan-progress-step-${step.id}`} data-status={step.status}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[12px] text-muted">{index + 1}.</span>
        <span className="min-w-0 flex-1 text-[13px] text-text-strong">{step.title}</span>
        <span className="badge badge-muted">{t(`assistantTools:preview.plan.packs.${step.pack}`)}</span>
        <PlanStepStatusBadge status={step.status} />
      </div>
      {step.status === 'done' && (step.kind === 'think' ? <StepResult outputs={step.outputs} /> : <StepOutputs outputs={step.outputs} />)}
      {step.error !== undefined && step.error !== '' && <p className="text-[12px] text-danger">{step.error}</p>}
      {step.status === 'needs_approval' && step.pending !== undefined && (
        <StepApproval
          pending={step.pending}
          numberOf={numberOf}
          busy={busy}
          onApprove={(fingerprint) => onResolve({ stepId: step.id, action: 'approve', fingerprint })}
          onDecline={() => onResolve({ stepId: step.id, action: 'decline' })}
        />
      )}
    </li>
  )
}
