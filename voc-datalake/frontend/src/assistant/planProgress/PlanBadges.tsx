/**
 * @fileoverview Status badges of a plan and of its steps, toned by STATE
 * (docs/kiro-design-system.md → "Labels vs status"): running = accent, done =
 * ok, waiting for a person = warn, failed = danger, inactive = muted.
 *
 * @module assistant/planProgress/PlanBadges
 */
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, Hourglass, Loader2, MinusCircle, XCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PlanStatus, PlanStepStatus } from '../../api/plansApi'

interface Look { tone: string; Icon: LucideIcon; spin?: boolean }

const RUNNING: Look = { tone: 'badge-accent', Icon: Loader2, spin: true }
const DONE: Look = { tone: 'badge-ok', Icon: CheckCircle2 }
const ATTENTION: Look = { tone: 'badge-warn', Icon: AlertTriangle }
const FAILED: Look = { tone: 'badge-danger', Icon: XCircle }
const INACTIVE: Look = { tone: 'badge-muted', Icon: MinusCircle }

const STEP_LOOKS: Record<PlanStepStatus, Look> = {
  pending: { tone: 'badge-muted', Icon: Hourglass },
  running: RUNNING,
  waiting: { tone: 'badge-accent', Icon: Hourglass },
  done: DONE,
  failed: FAILED,
  skipped: INACTIVE,
  needs_approval: ATTENTION,
  cancelled: INACTIVE,
}

const PLAN_LOOKS: Record<PlanStatus, Look> = {
  awaiting_approval: ATTENTION,
  approved: { tone: 'badge-accent', Icon: Hourglass },
  running: RUNNING,
  completed: DONE,
  completed_with_errors: ATTENTION,
  failed: FAILED,
  cancelled: INACTIVE,
  expired: INACTIVE,
}

function Badge({ look, label }: Readonly<{ look: Look; label: string }>) {
  const { Icon } = look
  return (
    <span className={clsx('badge inline-flex items-center gap-1', look.tone)}>
      <Icon className={clsx('h-3 w-3', look.spin === true && 'animate-spin')} aria-hidden="true" />
      {label}
    </span>
  )
}

export function PlanStepStatusBadge({ status }: Readonly<{ status: PlanStepStatus }>) {
  const { t } = useTranslation('assistant')
  return <Badge look={STEP_LOOKS[status]} label={t(`plan.stepStatus.${status}`)} />
}

export function PlanStatusBadge({ status }: Readonly<{ status: PlanStatus }>) {
  const { t } = useTranslation('assistant')
  return <Badge look={PLAN_LOOKS[status]} label={t(`plan.status.${status}`)} />
}
