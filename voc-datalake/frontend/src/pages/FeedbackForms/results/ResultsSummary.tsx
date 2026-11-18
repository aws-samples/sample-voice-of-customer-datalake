/**
 * @fileoverview Results › Summary (UX §10.1–10.3): the figures (Responses; Completion, with the beacon; Last
 * response), one card per question in form order, the endings with their counts, the questions removed since
 * (folded), and the drop-off: the funnel when the beacon's counts exist, else Reach.
 *
 * @module pages/FeedbackForms/results/ResultsSummary
 */
import { useTranslation } from 'react-i18next'
import { Clock, Flag, MessageSquare, TrendingDown } from 'lucide-react'
import MetricCard from '../../../components/MetricCard/MetricCard'
import type { FormResults } from '../../../api/feedbackFormsV2Results'
import { formatCount, formatPercent } from '../../../utils/numberFormat'
import { formatRelativeDate } from '../../../utils/dateUtils'
import type { FormV2 } from '../model/formsV2'
import QuestionResultCard from './QuestionResultCard'
import { FunnelCard, ReachCard } from './FunnelCard'
import { endingTitle } from './answers'
import { percentOf } from './scoreMath'

function Figures({ results }: Readonly<{ results: FormResults }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const funnel = results.funnel
  return (
    <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
      <MetricCard title={t('results.figures.responses')} value={results.total} icon={<MessageSquare size={20} aria-hidden="true" />} />
      {funnel !== null && (
        <MetricCard title={t('results.figures.completion')} icon={<TrendingDown size={20} aria-hidden="true" />}
          value={t('results.figures.ofOpened', { percent: formatPercent(percentOf(funnel.completed, funnel.opened), i18n.language) })} />
      )}
      <MetricCard title={t('results.figures.last')} icon={<Clock size={20} aria-hidden="true" />} color="muted"
        value={results.last_response_at === null ? '—' : formatRelativeDate(results.last_response_at, i18n.language)} />
    </div>
  )
}

function Endings({ form, results }: Readonly<{ form: FormV2; results: FormResults }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const ids = [...new Set([...form.endings.map((ending) => ending.id), ...Object.keys(results.endings)])]
  return (
    <section className="card space-y-2" aria-labelledby="results-endings">
      <h3 id="results-endings" className="text-sm font-semibold tracking-tight text-text-strong">{t('results.endings')}</h3>
      <ul className="space-y-1">
        {ids.map((id, index) => {
          const count = results.endings[id] ?? 0
          return (
            <li key={id} className="flex flex-wrap items-center gap-2 text-sm text-text">
              <Flag size={14} className="text-muted" aria-hidden="true" />
              <span>{endingTitle(form, id)}</span>
              {index === 0 && <span className="badge badge-muted">{t('results.defaultEnding')}</span>}
              <span className="tabular-nums text-muted">· {formatCount(count, i18n.language)} · {formatPercent(percentOf(count, results.total), i18n.language)}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function RemovedQuestions({ form, results }: Readonly<{ form: FormV2; results: FormResults }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  if (results.removed_questions.length === 0) return null
  return (
    <details className="card">
      <summary className="cursor-pointer text-sm font-semibold tracking-tight text-text-strong focus-ring rounded-md">
        {t('results.removedQuestions', { count: results.removed_questions.length })}
      </summary>
      <ul className="mt-3 space-y-1">
        {results.removed_questions.map((question) => (
          <li key={question.id} className="text-sm text-muted">
            {question.headline[form.language] ?? question.id} · {t('results.removedAnswered', { count: question.answered, formatted: formatCount(question.answered, i18n.language) })}
          </li>
        ))}
      </ul>
    </details>
  )
}

export default function ResultsSummary({ form, results, onShowAll }: Readonly<{
  form: FormV2
  results: FormResults
  /** Open Responses (an open question's "Show all N in Responses"). */
  onShowAll: () => void
}>) {
  return (
    <div className="space-y-4">
      <Figures results={results} />
      {form.questions.map((question, index) => (
        <QuestionResultCard key={question.id} form={form} question={question} number={index + 1} aggregate={results.questions[question.id]}
          removed={results.removed_options} funnel={results.funnel} onShowAll={onShowAll} />
      ))}
      <Endings form={form} results={results} />
      <RemovedQuestions form={form} results={results} />
      {results.funnel === null ? <ReachCard form={form} results={results} /> : <FunnelCard form={form} funnel={results.funnel} />}
    </div>
  )
}
