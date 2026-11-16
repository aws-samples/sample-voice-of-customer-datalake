/**
 * @fileoverview The setup guide's steps, in the recommended order, each a link to its path with where it stands
 * (done, skipped for now, to do, arriving in 7.52); the open one is marked as the current step.
 *
 * @module pages/Agents/SetupGuide/StepNav
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Circle, Clock, SkipForward } from 'lucide-react'
import clsx from 'clsx'
import { GUIDE_STEPS, progressCount } from './setupGuideRules'
import { setupGuidePath } from './setupGuidePaths'
import type { LucideIcon } from 'lucide-react'
import type { SetupStepId } from '../../../api/engineeringSetupApi'
import type { StepStatus, StepStatuses } from './setupGuideRules'

const STATUS_LOOK: Readonly<Record<StepStatus, { icon: LucideIcon; tone: string; badge: string }>> = {
  done: { icon: CheckCircle2, tone: 'text-ok', badge: 'badge badge-ok' },
  skipped: { icon: SkipForward, tone: 'text-warn', badge: 'badge badge-warn' },
  todo: { icon: Circle, tone: 'text-muted', badge: 'badge badge-muted' },
  later: { icon: Clock, tone: 'text-muted', badge: 'badge badge-muted' },
}

export function StepStatusBadge({ status }: Readonly<{ status: StepStatus }>) {
  const { t } = useTranslation('agents')
  return <span className={STATUS_LOOK[status].badge}>{t(`setupGuide.status.${status}`)}</span>
}

export function StepNav({ statuses, open }: Readonly<{ statuses: StepStatuses; open: SetupStepId }>) {
  const { t } = useTranslation('agents')
  const { done, total } = progressCount(statuses)
  return (
    <nav aria-label={t('setupGuide.stepsLabel')} className="space-y-2">
      <p className="text-[12px] text-muted">{t('setupGuide.progress', { done, total })}</p>
      <ol className="space-y-1">
        {GUIDE_STEPS.map((step, index) => {
          const look = STATUS_LOOK[statuses[step]]
          const Icon = look.icon
          const current = step === open
          return (
            <li key={step}>
              <Link to={setupGuidePath(step)} aria-current={current ? 'step' : undefined}
                className={clsx('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-bg-hover focus-ring',
                  current ? 'bg-accent-subtle text-accent-text font-semibold' : 'text-text')}>
                <Icon size={16} className={clsx('flex-shrink-0', look.tone)} aria-hidden="true" />
                <span className="min-w-0 flex-1">{index}. {t(`setupGuide.steps.${step}.title`)}</span>
                <span className="sr-only">{t(`setupGuide.status.${statuses[step]}`)}</span>
              </Link>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
