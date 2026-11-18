/**
 * @fileoverview Where people stop (UX §10.3). With the widget's open/step beacon (D6): Opened → Started → each
 * question on the path → Completed, the drop at each step and "largest drop" on the worst one (a warning, with an
 * icon and words). Without it, the card is titled Reach and lists how many completed responses answered each
 * question, and says why there is no funnel: there is never a fake one.
 *
 * @module pages/FeedbackForms/results/FunnelCard
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { FormFunnel, FormResults } from '../../../api/feedbackFormsV2Results'
import { formatCount, formatPercent } from '../../../utils/numberFormat'
import type { FormV2 } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { Bar } from './BarRow'
import { percentOf } from './scoreMath'

interface Step {
  readonly key: string
  readonly label: string
  readonly count: number
}

function stepsOf(form: FormV2, funnel: FormFunnel, words: { opened: string; started: string; completed: string }): Step[] {
  const question = (id: string) => {
    const at = form.questions.findIndex((q) => q.id === id)
    const q = form.questions[at]
    return q === undefined ? id : `${String(at + 1)} · ${textIn(q.headline, form.language)}`
  }
  return [
    { key: 'opened', label: words.opened, count: funnel.opened },
    { key: 'started', label: words.started, count: funnel.started },
    ...funnel.steps.map((step) => ({ key: step.question_id, label: question(step.question_id), count: step.reached })),
    { key: 'completed', label: words.completed, count: funnel.completed },
  ]
}

/** The index of the step with the largest drop from the one before (null: no drop at all). */
function largestDrop(steps: readonly Step[]): number | null {
  const drops = steps.map((step, index) => (index === 0 ? 0 : (steps[index - 1]?.count ?? 0) - step.count))
  const worst = Math.max(...drops)
  return worst <= 0 ? null : drops.indexOf(worst)
}

export function FunnelCard({ form, funnel }: Readonly<{ form: FormV2; funnel: FormFunnel }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const steps = stepsOf(form, funnel, { opened: t('results.funnel.opened'), started: t('results.funnel.started'), completed: t('results.funnel.completed') })
  const worst = largestDrop(steps)
  return (
    <section className="card space-y-3" aria-labelledby="results-funnel">
      <h3 id="results-funnel" className="text-sm font-semibold tracking-tight text-text-strong">{t('results.funnel.title')}</h3>
      <ol className="space-y-2">
        {steps.map((step, index) => {
          const previous = steps[index - 1]?.count
          const drop = previous === undefined || previous === 0 ? null : percentOf(previous - step.count, previous)
          return (
            <li key={step.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
              <span className="min-w-0 break-words text-sm text-text">{step.label}</span>
              <span className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto"><Bar percent={percentOf(step.count, funnel.opened)} /></span>
              <span className="text-right text-[12px] tabular-nums text-text">
                {formatCount(step.count, i18n.language)}
                {step.key === 'completed' && <span className="text-muted"> · {t('results.funnel.ofOpened', { percent: formatPercent(percentOf(step.count, funnel.opened), i18n.language) })}</span>}
                {step.key !== 'completed' && drop !== null && drop > 0 && <span className="text-muted"> · −{formatPercent(drop, i18n.language)}</span>}
                {worst === index && (
                  <span className="ml-2 inline-flex items-center gap-1 text-warn"><AlertTriangle size={12} aria-hidden="true" />{t('results.funnel.largestDrop')}</span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export function ReachCard({ form, results }: Readonly<{ form: FormV2; results: FormResults }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  return (
    <section className="card space-y-3" aria-labelledby="results-reach">
      <h3 id="results-reach" className="text-sm font-semibold tracking-tight text-text-strong">{t('results.reachCard.title')}</h3>
      <ol className="space-y-2">
        {form.questions.map((question, index) => {
          const answered = results.questions[question.id]?.answered ?? 0
          return (
            <li key={question.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
              <span className="min-w-0 break-words text-sm text-text">{index + 1} · {textIn(question.headline, form.language)}</span>
              <span className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto"><Bar percent={percentOf(answered, results.total)} /></span>
              <span className="text-right text-[12px] tabular-nums text-text">
                {t('results.reachCard.answeredBy', { answered: formatCount(answered, i18n.language), total: formatCount(results.total, i18n.language) })}
              </span>
            </li>
          )
        })}
      </ol>
      <p className="text-[12px] text-muted">{t('results.reachCard.note')}</p>
    </section>
  )
}
