/**
 * @fileoverview One template in the picker (UX §2.2): a toggle button (`aria-pressed`) with its icon tile, name and
 * purpose (in the app's language: they describe the template to the person creating the form), its question types
 * as chips ("Short text ×2", at most four, then "+2 more"), where it is meant to run and the estimate ("~1 min").
 *
 * @module pages/FeedbackForms/picker/TemplateCard
 */
import { createElement } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { TemplateFlow } from '../templates/templateKit'
import TypeChip from '../ui/TypeChip'
import { typeNameKey } from '../ui/typeIcons'
import { templateMinutes, typeSummary, useRunsLine } from './templateSummary'

const MAX_CHIPS = 4

export default function TemplateCard({ flow, selected, onSelect }: Readonly<{
  flow: TemplateFlow
  selected: boolean
  onSelect: (id: string) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const runs = useRunsLine(flow)
  const summary = typeSummary(flow.questions)
  return (
    <button type="button" aria-pressed={selected} onClick={() => onSelect(flow.id)} data-testid={`template-${flow.id}`}
      className={clsx('card flex w-full flex-col gap-2 p-4 text-left transition-colors focus-ring',
        selected ? 'border-accent bg-accent-subtle' : 'hover:bg-bg-hover')}>
      <span className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted" aria-hidden="true">
          {createElement(flow.icon, { size: 18 })}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-text-strong">{t(`templates.${flow.id}.name`)}</span>
          <span className={clsx('block text-[13px] line-clamp-2', selected ? 'text-text' : 'text-muted')}>{t(`templates.${flow.id}.purpose`)}</span>
        </span>
      </span>
      <span className="flex flex-wrap gap-1">
        {summary.slice(0, MAX_CHIPS).map(({ question, count }) => <TypeChip key={typeNameKey(question)} question={question} count={count} />)}
        {summary.length > MAX_CHIPS && <span className="badge badge-muted">{t('picker.moreTypes', { count: summary.length - MAX_CHIPS })}</span>}
      </span>
      <span className={clsx('text-[12px]', selected ? 'text-text' : 'text-muted')}>
        {runs} · {t('picker.minutes', { count: templateMinutes(flow) })}
      </span>
    </button>
  )
}
