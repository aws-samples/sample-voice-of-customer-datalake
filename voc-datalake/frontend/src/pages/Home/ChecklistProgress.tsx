/**
 * @fileoverview A checklist's parts on Home: its progress, "n of m done" over a labelled progressbar, and a step's
 * status icon. The setup checklist (onboarding/OnboardingBuddy.tsx) and the role playbook (playbooks/RolePlaybook.tsx)
 * each word them in their namespace.
 *
 * @module pages/Home/ChecklistProgress
 */
import { CheckCircle2, Circle, Loader2 } from 'lucide-react'
import type { StepStatus } from './onboarding/onboardingSteps'

/** A step's status: done, to do, or its evidence still loading. */
export function StatusIcon({ status }: Readonly<{ status: StepStatus }>) {
  if (status === 'done') return <CheckCircle2 size={20} className="text-ok" aria-hidden="true" />
  if (status === 'pending') return <Loader2 size={20} className="animate-spin text-muted" aria-hidden="true" />
  return <Circle size={20} className="text-muted" aria-hidden="true" />
}

interface Props {
  readonly done: number
  readonly total: number
  /** The visible line, also the bar's value text ("2 of 5 done"). */
  readonly text: string
  /** The bar's accessible name. */
  readonly label: string
}

export default function ChecklistProgress({ done, total, text, label }: Props) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-text" aria-hidden="true">{text}</p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={text}
        className="h-2 w-full overflow-hidden rounded-full bg-bg-accent"
      >
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
