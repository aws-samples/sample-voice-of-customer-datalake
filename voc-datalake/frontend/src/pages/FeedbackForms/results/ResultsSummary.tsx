/**
 * @fileoverview Results › Summary (UX §10.1–10.3): the figures (Responses; Completion, with the beacon, and "largest
 * drop at Q2", which moves to the funnel; Last response), one card per question in form order, the endings with their
 * counts, the questions removed since (folded), and the drop-off: the funnel when the beacon's counts exist, else
 * Reach. Under a language, ending or hidden-value filter (`funnelFiltered`) neither the funnel nor Completion is
 * shown, whatever the server sent: its counters are every visit's, and Reach says why.
 *
 * @module pages/FeedbackForms/results/ResultsSummary
 */
import { useTranslation } from 'react-i18next'
import { Clock, Flag, MessageSquare, TrendingDown } from 'lucide-react'
import MetricCard from '../../../components/MetricCard/MetricCard'
import type { FormFunnel, FormResults } from '../../../api/feedbackFormsV2Results'
import { formatCount, formatPercent } from '../../../utils/numberFormat'
import { formatRelativeDate } from '../../../utils/dateUtils'
import type { FormV2 } from '../model/formsV2'
import QuestionResultCard from './QuestionResultCard'
import { FunnelCard, ReachCard } from './FunnelCard'
import { FUNNEL_HEADING_ID, funnelSteps, largestDrop } from './funnelSteps'
import { endingTitle } from './answers'
import { percentOf } from './scoreMath'

/** "largest drop at Q2", the funnel's own marker in the figures row; it moves to the funnel card. */
function LargestDropLink({ form, funnel, results }: Readonly<{ form: FormV2; funnel: FormFunnel; results: FormResults }>) {
  const { t } = useTranslation('feedbackForms')
  const steps = funnelSteps(form, funnel, results)
  const step = steps[largestDrop(steps) ?? -1]
  if (step === undefined) return null
  const named = step.key === 'started' ? t('results.funnel.started') : t('results.funnel.completed')
  const where = step.number === null ? named : t('results.figures.questionShort', { position: step.number })
  const show = () => {
    const heading = document.getElementById(FUNNEL_HEADING_ID)
    heading?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    heading?.focus({ preventScroll: true })
  }
  return <button type="button" className="link text-[12px]" onClick={show}>{t('results.figures.largestDropAt', { step: where })}</button>
}

function Figures({ form, results }: Readonly<{ form: FormV2; results: FormResults }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const funnel = results.funnel
  return (
    <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
      <MetricCard title={t('results.figures.responses')} value={results.total} icon={<MessageSquare size={20} aria-hidden="true" />} />
      {funnel !== null && (
        <MetricCard title={t('results.figures.completion')} icon={<TrendingDown size={20} aria-hidden="true" />}
          value={t('results.figures.ofOpened', { percent: formatPercent(percentOf(funnel.completed, funnel.opened), i18n.language) })}
          detail={<LargestDropLink form={form} funnel={funnel} results={results} />} />
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

export default function ResultsSummary({ form, results, funnelFiltered = false, onShowAll }: Readonly<{
  form: FormV2
  results: FormResults
  /** The view filters by a language, an ending or a hidden value (resultFilters.ts `hidesFunnel`): no funnel then. */
  funnelFiltered?: boolean
  /** Open Responses (an open question's "Show all N in Responses"). */
  onShowAll: () => void
}>) {
  const shown: FormResults = funnelFiltered ? { ...results, funnel: null } : results
  return (
    <div className="space-y-4">
      <Figures form={form} results={shown} />
      {form.questions.map((question, index) => (
        <QuestionResultCard key={question.id} form={form} question={question} number={index + 1} aggregate={shown.questions[question.id]}
          removed={shown.removed_options} funnel={shown.funnel} onShowAll={onShowAll} />
      ))}
      <Endings form={form} results={shown} />
      <RemovedQuestions form={form} results={shown} />
      {shown.funnel === null
        ? <ReachCard form={form} results={shown} filtered={funnelFiltered} />
        : <FunnelCard form={form} funnel={shown.funnel} results={shown} />}
    </div>
  )
}

