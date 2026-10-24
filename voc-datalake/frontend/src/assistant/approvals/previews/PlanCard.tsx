/**
 * @fileoverview The `propose_plan` approval preview (docs/assistant-plan-mode.md
 * → "UI"): the goal, the steps in order with their page (pack) and kind, each
 * write as a fixed field table built from its declared arguments (placeholders
 * spelled out), "will ask again" on the tools that always get a card at run
 * time, and the limits. Approving the card approves every write as shown.
 *
 * The plan is re-checked here (as the executor does before it posts) so a
 * problem is visible before anyone approves; the server checks it a third time.
 *
 * @module assistant/approvals/previews/PlanCard
 */
import { useTranslation } from 'react-i18next'
import { Brain, Hourglass, PenLine, RotateCcw } from 'lucide-react'
import { useIsAdmin } from '../../../store/authStore'
import { NEVER_PREAPPROVABLE_TOOLS, PLAN_LIMITS } from '../../plan/schema'
import { validatePlan } from '../../plan/validate'
import { packsAllowedFor } from '../../plan/packsAllowed'
import { FieldTable } from './FieldDiff'
import { planArgRows } from './planRows'
import type { PlanStep, VocPlan } from '../../plan/schema'
import type { StepNumberOf } from './planRows'

const KIND_ICONS = { write: PenLine, wait: Hourglass, think: Brain } as const
const NEVER_PREAPPROVABLE: ReadonlySet<string> = new Set(NEVER_PREAPPROVABLE_TOOLS)

type Translate = (key: string, options?: Record<string, unknown>) => string

/** The step's own label: the tool's card title for a write, the wait kind, or "Analysis". */
function stepAction(step: PlanStep, t: Translate): string {
  if (step.kind === 'write') return t(`tools.${step.write.tool}.title`, { defaultValue: step.write.tool })
  if (step.kind === 'wait') return t(`preview.plan.waitFor.${step.wait.for}`)
  return t('preview.plan.think')
}

function StepBody({ step, numberOf }: Readonly<{ step: PlanStep; numberOf: StepNumberOf }>) {
  const { t } = useTranslation('assistantTools')
  if (step.kind === 'think') return <p className="whitespace-pre-wrap text-[13px] text-text">{step.think.brief}</p>
  // A wait's kind is already its action line; its ids and timeout are the rows.
  const args: Record<string, unknown> = step.kind === 'write'
    ? step.write.args
    : Object.fromEntries(Object.entries(step.wait).filter(([key]) => key !== 'for'))
  const rows = planArgRows(args, numberOf, t)
  if (rows.length === 0) return <p className="text-[12px] text-muted">{t('preview.plan.noArgs')}</p>
  return <FieldTable rows={rows} label={t('preview.plan.fields', { title: step.title })} />
}

function StepItem({ step, index, numberOf }: Readonly<{ step: PlanStep; index: number; numberOf: StepNumberOf }>) {
  const { t } = useTranslation('assistantTools')
  const Icon = KIND_ICONS[step.kind]
  const asksAgain = step.kind === 'write' && NEVER_PREAPPROVABLE.has(step.write.tool)
  const after = (step.after ?? []).map((id) => numberOf(id) ?? id)
  return (
    <li className="space-y-1.5 rounded-md border border-border bg-bg-accent p-2" data-testid={`plan-step-${step.id}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[12px] text-muted">{index + 1}.</span>
        <span className="text-[13px] font-medium text-text-strong">{step.title}</span>
        <span className="badge badge-muted">{t(`preview.plan.packs.${step.pack}`)}</span>
        <span className="badge badge-muted inline-flex items-center gap-1">
          <Icon className="h-3 w-3" aria-hidden="true" />
          {t(`preview.plan.kinds.${step.kind}`)}
        </span>
        {asksAgain && (
          <span className="badge badge-warn inline-flex items-center gap-1">
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            {t('preview.plan.asksAgain')}
          </span>
        )}
      </div>
      <p className="text-[12px] text-muted">
        {stepAction(step, t)}
        {after.length > 0 && ` · ${t('preview.plan.after', { steps: after.join(', ') })}`}
      </p>
      <StepBody step={step} numberOf={numberOf} />
    </li>
  )
}

function LimitsLine({ plan }: Readonly<{ plan: VocPlan }>) {
  const { t } = useTranslation('assistantTools')
  const count = (kind: PlanStep['kind']) => plan.steps.filter((s) => s.kind === kind).length
  return (
    <p className="text-[12px] text-muted" data-testid="plan-limits">
      {t('preview.plan.limits', {
        steps: plan.steps.length, maxSteps: PLAN_LIMITS.steps,
        writes: count('write'), maxWrites: PLAN_LIMITS.writes,
        waits: count('wait'), maxWaits: PLAN_LIMITS.waits,
        thinks: count('think'), maxThinks: PLAN_LIMITS.thinks,
      })}
    </p>
  )
}

function PlanProblems({ plan }: Readonly<{ plan: VocPlan }>) {
  const { t } = useTranslation('assistantTools')
  const isAdmin = useIsAdmin()
  const checked = validatePlan(plan, { isAdmin, packsAllowed: packsAllowedFor(isAdmin) })
  if (checked.ok) return null
  return (
    <div role="alert" className="rounded-md border border-danger/30 bg-danger-subtle p-2 text-[12px] text-danger">
      <p className="font-medium">{t('preview.plan.invalid')}</p>
      <ul className="mt-1 list-disc pl-4">
        {checked.errors.map((e) => (
          <li key={`${e.step ?? ''}:${e.field ?? ''}:${e.message}`}>{[e.step, e.field, e.message].filter(Boolean).join(' · ')}</li>
        ))}
      </ul>
    </div>
  )
}

export function PlanCard({ args }: Readonly<{ args: VocPlan }>) {
  const { t } = useTranslation('assistantTools')
  const numbers = new Map(args.steps.map((step, index) => [step.id, index + 1]))
  const numberOf: StepNumberOf = (id) => numbers.get(id)
  return (
    <div className="space-y-2" data-testid="plan-card">
      <p className="text-[12px] font-medium text-muted">{t('preview.plan.goal')}</p>
      <p className="text-sm text-text-strong">{args.goal}</p>
      <PlanProblems plan={args} />
      <ol className="space-y-2" aria-label={t('preview.plan.steps')}>
        {args.steps.map((step, index) => <StepItem key={step.id} step={step} index={index} numberOf={numberOf} />)}
      </ol>
      <LimitsLine plan={args} />
      <p className="rounded-md border border-info/30 bg-info-subtle p-2 text-[12px] text-info">{t('preview.plan.runsInBackground')}</p>
    </div>
  )
}
