/**
 * @fileoverview Where people stop (UX §10.3). With the widget's open/step beacon (D6): Opened → Started → each
 * question → Completed, the drop at each step every path passes and "largest drop" on the worst one (a warning, with
 * an icon and words); a question only some paths show says so instead of a drop (funnelSteps.ts). Without the beacon,
 * or under a language, ending or hidden-value filter its counters cannot follow, the card is titled Reach and lists
 * how many completed responses answered each question, and says why there is no funnel: there is never a fake one.
 *
 * @module pages/FeedbackForms/results/FunnelCard
 */
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { AlertTriangle } from 'lucide-react'
import type { FormFunnel, FormResults } from '../../../api/feedbackFormsV2Results'
import { formatCount, formatPercent } from '../../../utils/numberFormat'
import type { FormV2 } from '../model/formsV2'
import { headlineShown } from '../model/recall'
import { Bar } from './BarRow'
import { percentOf } from './scoreMath'
import { FUNNEL_HEADING_ID, funnelSteps, largestDrop } from './funnelSteps'
import type { FunnelStep } from './funnelSteps'

function stepLabel(t: TFunction<'feedbackForms'>, form: FormV2, step: FunnelStep): string {
  if (step.key === 'opened') return t('results.funnel.opened')
  if (step.key === 'started') return t('results.funnel.started')
  if (step.key === 'completed') return t('results.funnel.completed')
  const question = form.questions.find((q) => q.id === step.key)
  return question === undefined || step.number === null ? step.key : `${String(step.number)} · ${headlineShown(question, form.language)}`
}

export function FunnelCard({ form, funnel, results }: Readonly<{ form: FormV2; funnel: FormFunnel; results: FormResults }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const steps = funnelSteps(form, funnel, results)
  const worst = largestDrop(steps)
  return (
    <section className="card space-y-3" aria-labelledby={FUNNEL_HEADING_ID}>
      <h3 id={FUNNEL_HEADING_ID} tabIndex={-1} className="rounded-sm text-sm font-semibold tracking-tight text-text-strong focus-ring">{t('results.funnel.title')}</h3>
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li key={step.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
            <span className="min-w-0 break-words text-sm text-text">{stepLabel(t, form, step)}</span>
            <span className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto"><Bar percent={percentOf(step.count, funnel.opened)} /></span>
            <span className="text-right text-[12px] tabular-nums text-text">
              {formatCount(step.count, i18n.language)}
              {step.key === 'completed' && <span className="text-muted"> · {t('results.funnel.ofOpened', { percent: formatPercent(percentOf(step.count, funnel.opened), i18n.language) })}</span>}
              {step.key !== 'completed' && step.dropPercent !== null && step.dropPercent > 0 && <span className="text-muted"> · −{formatPercent(step.dropPercent, i18n.language)}</span>}
              {!step.everyPath && <span className="text-muted"> · {t('results.funnel.somePaths')}</span>}
              {worst === index && (
                <span className="ml-2 inline-flex items-center gap-1 text-warn"><AlertTriangle size={12} aria-hidden="true" />{t('results.funnel.largestDrop')}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {steps.some((step) => !step.everyPath) && <p className="text-[12px] text-muted">{t('results.funnel.somePathsNote')}</p>}
    </section>
  )
}

export function ReachCard({ form, results, filtered = false }: Readonly<{
  form: FormV2; results: FormResults
  /** No funnel because the view filters by what its counters don't know (else: no view tracking yet). */
  filtered?: boolean
}>) {
  const { t, i18n } = useTranslation('feedbackForms')
  return (
    <section className="card space-y-3" aria-labelledby="results-reach">
      <h3 id="results-reach" className="text-sm font-semibold tracking-tight text-text-strong">{t('results.reachCard.title')}</h3>
      <ol className="space-y-2">
        {form.questions.map((question, index) => {
          const answered = results.questions[question.id]?.answered ?? 0
          return (
            <li key={question.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
              <span className="min-w-0 break-words text-sm text-text">{index + 1} · {headlineShown(question, form.language)}</span>
              <span className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto"><Bar percent={percentOf(answered, results.total)} /></span>
              <span className="text-right text-[12px] tabular-nums text-text">
                {t('results.reachCard.answeredBy', { answered: formatCount(answered, i18n.language), total: formatCount(results.total, i18n.language) })}
              </span>
            </li>
          )
        })}
      </ol>
      <p className="text-[12px] text-muted">{filtered ? t('results.reachCard.filtered') : t('results.reachCard.note')}</p>
    </section>
  )
}
