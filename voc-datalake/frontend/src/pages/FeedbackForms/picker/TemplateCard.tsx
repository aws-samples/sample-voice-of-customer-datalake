/**
 * @fileoverview One template in the picker (UX §2.2): a toggle button (`aria-pressed`), a horizontal card (one column
 * of them below 2xl, two at 2xl) with its icon tile, name and purpose (two lines at most; in the app's language: they
 * describe the template to the person creating the form) and the estimate ("~1 min"), then its question types as
 * chips in one row that never wraps ("Short text ×2", at most three, two on a card under 28rem, then "+2 more") and
 * where it is meant to run.
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

const MAX_CHIPS = 3

/** "+2 more": the types the row does not show (nothing when it shows them all). */
function MoreChip({ count, className }: Readonly<{ count: number; className: string }>) {
  const { t } = useTranslation('feedbackForms')
  if (count <= 0) return null
  return <span className={clsx('badge badge-muted shrink-0', className)}>{t('picker.moreTypes', { count })}</span>
}

export default function TemplateCard({ flow, selected, onSelect }: Readonly<{
  flow: TemplateFlow
  selected: boolean
  onSelect: (id: string) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const runs = useRunsLine(flow)
  const summary = typeSummary(flow.questions)
  const meta = selected ? 'text-text' : 'text-muted'
  return (
    <button type="button" aria-pressed={selected} onClick={() => onSelect(flow.id)} data-testid={`template-${flow.id}`}
      className={clsx('card @container grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 p-3 text-left transition-colors focus-ring',
        selected ? 'border-accent bg-accent-subtle' : 'hover:bg-bg-hover')}>
      <span className="row-span-2 flex h-9 w-9 items-center justify-center rounded-md bg-bg-hover text-muted" aria-hidden="true">
        {createElement(flow.icon, { size: 18 })}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-text-strong">{t(`templates.${flow.id}.name`)}</span>
        {/* (no `block` beside the clamp: `display: block` beat `line-clamp-2`'s -webkit-box, 4 lines at 268 px) */}
        <span className={clsx('line-clamp-2 text-[13px]', meta)}>{t(`templates.${flow.id}.purpose`)}</span>
      </span>
      <span className={clsx('whitespace-nowrap text-[12px] tabular-nums', meta)}>{t('picker.minutes', { count: templateMinutes(flow) })}</span>
      <span className="col-span-2 col-start-2 flex min-w-0 flex-col gap-1.5">
        {/* (one row that never wraps: three chips from a 28rem card, two below it, and "+N" always whole after them) */}
        <span className="flex min-w-0 flex-nowrap items-center gap-1">
          <span className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden">
            {summary.slice(0, MAX_CHIPS).map(({ question, count }, index) => (
              <span key={typeNameKey(question)} className={clsx('shrink-0', index === MAX_CHIPS - 1 && 'hidden @md:inline-flex')}>
                <TypeChip question={question} count={count} />
              </span>
            ))}
          </span>
          <MoreChip count={summary.length - (MAX_CHIPS - 1)} className="@md:hidden" />
          <MoreChip count={summary.length - MAX_CHIPS} className="hidden @md:inline-flex" />
        </span>
        <span className={clsx('text-[12px]', meta)}>{runs}</span>
      </span>
    </button>
  )
}
