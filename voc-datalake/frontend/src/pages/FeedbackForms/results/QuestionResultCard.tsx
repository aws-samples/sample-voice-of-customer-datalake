/**
 * @fileoverview One question's card on Results › Summary (UX §10.2): its number, type and headline, the reach line
 * every card carries ("Answered 140 · Skipped 12 · Not shown 460 (logic)": not shown means the respondent's path
 * jumped past it, so a follow-up's small count reads right), a provenance badge when its options changed while live,
 * and the type's own figures.
 *
 * @module pages/FeedbackForms/results/QuestionResultCard
 */
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import type { QuestionAggregate } from '../../../api/feedbackFormsV2Results'
import type { FormFunnel } from '../../../api/feedbackFormsV2Results'
import { formatCount } from '../../../utils/numberFormat'
import { formatDate } from '../../../utils/dateUtils'
import type { FormV2, Question } from '../model/formsV2'
import { isChoice, isScale } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import TypeChip from '../ui/TypeChip'
import ChoiceResult from './ChoiceResult'
import ScaleResult from './ScaleResult'
import { ConsentResult, ContactResult, OpenTextResult } from './OpenTextResult'

const EMPTY: QuestionAggregate = { answered: 0, skipped: 0, not_shown: 0 }

type RemovedOptions = Readonly<Record<string, readonly { code: string; label: Record<string, string>; count: number }[]>>

function StatementResult({ question, funnel }: Readonly<{ question: Question; funnel: FormFunnel | null }>) {
  const { t } = useTranslation('feedbackForms')
  const shown = funnel?.steps.find((step) => step.question_id === question.id)?.reached
  return <p className="text-sm text-muted">{shown === undefined ? t('results.statementNone') : t('results.statementShown', { count: shown })}</p>
}

function Figures({ form, question, aggregate, removed, funnel, onShowAll }: Readonly<{
  form: FormV2
  question: Question
  aggregate: QuestionAggregate
  removed: RemovedOptions
  funnel: FormFunnel | null
  onShowAll: () => void
}>) {
  if (isChoice(question)) return <ChoiceResult question={question} aggregate={aggregate} removed={removed[question.id] ?? []} language={form.language} />
  if (isScale(question)) return <ScaleResult question={question} aggregate={aggregate} language={form.language} />
  if (question.type === 'open_text') return <OpenTextResult aggregate={aggregate} onShowAll={onShowAll} />
  if (question.type === 'consent') return <ConsentResult aggregate={aggregate} />
  if (question.type === 'contact_info') return <ContactResult aggregate={aggregate} />
  return <StatementResult question={question} funnel={funnel} />
}

export default function QuestionResultCard({ form, question, number, aggregate, removed, funnel, onShowAll }: Readonly<{
  form: FormV2
  question: Question
  number: number
  aggregate: QuestionAggregate | undefined
  removed: RemovedOptions
  funnel: FormFunnel | null
  onShowAll: () => void
}>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const figures = aggregate ?? EMPTY
  const count = (value: number) => formatCount(value, i18n.language)
  return (
    <section className="card space-y-3" aria-labelledby={`result-${question.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={`result-${question.id}`} className="min-w-0 flex-1 text-sm font-semibold tracking-tight text-text-strong">
          {number} · {textIn(question.headline, form.language)}
        </h3>
        <TypeChip question={question} />
      </div>
      <p className="text-[12px] text-muted tabular-nums">
        {t('results.reach', { answered: count(figures.answered), skipped: count(figures.skipped), hidden: count(figures.not_shown) })}
      </p>
      {figures.changed_at !== undefined && (
        <span className="badge badge-info inline-flex items-center gap-1">
          <Info size={12} aria-hidden="true" />{t('results.changed', { date: formatDate(figures.changed_at, i18n.language) })}
        </span>
      )}
      <Figures form={form} question={question} aggregate={figures} removed={removed} funnel={funnel} onShowAll={onShowAll} />
    </section>
  )
}
