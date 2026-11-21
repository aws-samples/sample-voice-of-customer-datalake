/**
 * @fileoverview The picker's Start rail (UX §2.2): "Describe it" first (it moves focus to the description), then the
 * goal filter with its counts (`tabular-nums`): All, Loyalty, Drop-offs, Product, Onboarding, Events, This app, Blank. A
 * list on desktop; a scrolling row on narrow screens.
 *
 * @module pages/FeedbackForms/picker/GoalRail
 */
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Sparkles } from 'lucide-react'
import { FORM_TEMPLATES } from '../formTemplates'
import { TEMPLATE_GROUPS } from '../templates/templateKit'
import type { TemplateGroup } from '../templates/templateKit'

export type GoalFilter = 'all' | TemplateGroup

const FILTERS: readonly GoalFilter[] = ['all', ...TEMPLATE_GROUPS]

const countOf = (filter: GoalFilter): number =>
  (filter === 'all' ? FORM_TEMPLATES.length : FORM_TEMPLATES.filter((flow) => flow.group === filter).length)

export default function GoalRail({ value, onChange, onDescribe }: Readonly<{
  value: GoalFilter
  onChange: (filter: GoalFilter) => void
  /** "Describe it": go to the description. */
  onDescribe: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <nav aria-label={t('picker.railLabel')} className="md:sticky md:top-4 md:self-start">
      <div className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
        <button type="button" onClick={onDescribe}
          className="flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium text-text hover:bg-bg-hover focus-ring">
          <Sparkles size={14} className="text-aim" aria-hidden="true" />{t('picker.describeIt')}
        </button>
        <div role="group" aria-label={t('picker.goalsLabel')} className="flex gap-1 md:mt-1 md:flex-col md:border-t md:border-border md:pt-1">
          {FILTERS.map((filter) => (
            <button key={filter} type="button" aria-pressed={value === filter} onClick={() => onChange(filter)}
              className={clsx('flex shrink-0 items-center justify-between gap-3 rounded-md px-3 py-2 text-[13px] focus-ring',
                value === filter ? 'nav-active' : 'text-muted hover:bg-bg-hover hover:text-text')}>
              <span>{t(`picker.groups.${filter}`)}</span>
              <span className="tabular-nums">{countOf(filter)}</span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  )
}
