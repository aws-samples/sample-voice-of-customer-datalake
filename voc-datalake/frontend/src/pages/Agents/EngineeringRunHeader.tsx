/**
 * @fileoverview The run monitor's header: the run's goal, repository, status and start, and its MicroVM time, messages
 * and tokens per model, and its flow's monthly budget with the highest level its flow's month passed (the flag the
 * supervisor sets as it says each alert). No cost yet: it comes with the run control's own item.
 *
 * @module pages/Agents/EngineeringRunHeader
 */
import { useTranslation } from 'react-i18next'
import { formatCalendarMonth, formatDateTime } from '../../utils/dateUtils'
import { shareTone } from './spendView'
import type { EngineeringOverview } from '../../api/engineeringRunsApi'

function Totals({ totals }: Readonly<{ totals: EngineeringOverview['totals'] }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="space-y-1 text-[13px] text-muted">
      <p>{t('engineeringRun.totals', { seconds: totals.microvm_seconds, messages: totals.messages })}</p>
      {totals.by_model.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label={t('engineeringRun.byModel')}>
          {totals.by_model.map((row) => (
            <li key={row.model} className="min-w-0 break-words">
              {t('engineeringRun.modelTokens', { model: row.model || '—', input: row.input_tokens, output: row.output_tokens })}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function BudgetFlag({ budget }: Readonly<{ budget: NonNullable<EngineeringOverview['run']['budget']> }>) {
  const { t, i18n } = useTranslation('agents')
  const amount = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' }).format(budget.monthly_usd)
  return (
    <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
      <span>{t('engineeringRun.budget', { amount })}</span>
      {budget.alert_percent !== null && (
        <span className={shareTone(budget.alert_percent)}>
          {t('engineeringRun.budgetPassed', {
            percent: budget.alert_percent, month: formatCalendarMonth(budget.alert_month ?? '', i18n.language) })}
        </span>
      )}
    </p>
  )
}

export function EngineeringRunHeader({ overview }: Readonly<{ overview: EngineeringOverview }>) {
  const { t, i18n } = useTranslation('agents')
  const { run } = overview
  return (
    <div className="card space-y-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-text-strong break-words">{run.goal || t('engineeringRun.untitled')}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span className="badge badge-muted">{run.status || t('engineeringRun.statusUnknown')}</span>
          {run.repo !== '' && <span className="font-mono break-all">{run.repo}</span>}
          <span>{t('engineeringRun.started', { when: formatDateTime(run.started_at, i18n.language, '—') })}</span>
          {run.ended_at !== null && <span>{t('engineeringRun.ended', { when: formatDateTime(run.ended_at, i18n.language, '—') })}</span>}
        </p>
      </div>
      <Totals totals={overview.totals} />
      {run.budget !== null && <BudgetFlag budget={run.budget} />}
    </div>
  )
}
