/**
 * @fileoverview The wizard's First insights: how many rows were imported (and why any were not), how many are
 * analysed so far, then the sentiment split, the top categories, a survey's NPS and three quotes, with a link to the
 * dashboard filtered to the source (and to the form's results for a survey). A reviews import none of whose rows is
 * analysed in the polling window was imported before: it says so, with the dashboard's link (a survey only says it is
 * slow: its rows are new items each time).
 *
 * @module pages/Scrapers/ImportWizard/InsightsStep
 */
import { CheckCircle, Loader2 } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type { RowRefusal } from '../../../api/importWizardSchema'
import { signedScore } from '../../FeedbackForms/results/scoreMath'
import { useFirstInsights } from './useFirstInsights'
import type { ImportOutcome, ImportWizardState } from './useImportWizard'

const SHOWN_REFUSALS = 5

/** The dashboard filtered to the import's source. */
function dashboardPath(outcome: ImportOutcome): string {
  return `/dashboard?source=${encodeURIComponent(outcome.source)}`
}
const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const

function Refusals({ outcome }: Readonly<{ outcome: ImportOutcome }>) {
  const { t } = useTranslation('scrapers')
  if (outcome.refusedCount === 0) return null
  const reason = (refusal: RowRefusal) => t(`importWizard.refusals.${refusal.code}`, { defaultValue: t('importWizard.refusals.other') })
  return (
    <div className="space-y-1">
      <p className="text-sm text-warn">{t('importWizard.insights.refused', { count: outcome.refusedCount })}</p>
      <ul className="text-xs text-muted space-y-0.5">
        {outcome.refused.slice(0, SHOWN_REFUSALS).map((refusal) => (
          <li key={refusal.row}>{t('importWizard.insights.refusedRow', { row: refusal.row, reason: reason(refusal) })}</li>
        ))}
      </ul>
    </div>
  )
}

function Figures({ outcome }: Readonly<{ outcome: ImportOutcome }>) {
  const { t } = useTranslation('scrapers')
  const insights = useFirstInsights(outcome)
  if (insights.alreadyImported) {
    return (
      <p role="status" className="text-sm text-text">
        {t('importWizard.insights.alreadyImported')}{' '}
        <Link className="link" to={dashboardPath(outcome)}>{t('importWizard.insights.alreadyImportedLink')}</Link>
      </p>
    )
  }
  if (!insights.ready) {
    return (
      <div role="status" className="space-y-1">
        <p className="text-sm text-text inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {t('importWizard.insights.processing', { done: insights.processed, total: outcome.accepted })}</p>
        {insights.slow && <p className="text-xs text-muted">{t('importWizard.insights.slow')}</p>}
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-text-strong inline-flex items-center gap-2"><CheckCircle size={14} className="text-success" aria-hidden="true" />
        {t('importWizard.insights.ready', { count: insights.processed })}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border p-3">
          <h3 className="text-xs font-semibold uppercase tracking-[.08em] text-muted mb-1">{t('importWizard.insights.sentiment')}</h3>
          <ul className="text-sm space-y-0.5">
            {SENTIMENTS.filter((name) => (insights.sentiment[name] ?? 0) > 0).map((name) => (
              <li key={name}>{t(`importWizard.insights.sentiments.${name}`)}: {Math.round(insights.sentiment[name] ?? 0)} %</li>
            ))}
          </ul>
        </div>
        <div className="rounded-md border border-border p-3">
          <h3 className="text-xs font-semibold uppercase tracking-[.08em] text-muted mb-1">{t('importWizard.insights.topCategories')}</h3>
          <ol className="text-sm space-y-0.5">{insights.categories.map(([name, count]) => <li key={name}>{name} ({count})</li>)}</ol>
        </div>
        {insights.nps !== null && (
          <div className="rounded-md border border-border p-3">
            <h3 className="text-xs font-semibold uppercase tracking-[.08em] text-muted mb-1">{t('importWizard.insights.nps')}</h3>
            <p className="text-2xl font-bold text-text-strong">{signedScore(insights.nps)}</p>
          </div>
        )}
      </div>
      {insights.quotes.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[.08em] text-muted mb-1">{t('importWizard.insights.quotes')}</h3>
          <ul className="space-y-1.5">{insights.quotes.map((quote) => (
            <li key={quote.id}><blockquote className="text-sm text-text border-l-2 border-border pl-3 line-clamp-3">{quote.text}</blockquote></li>
          ))}</ul>
        </div>
      )}
    </div>
  )
}

export default function InsightsStep({ wizard }: Readonly<{ wizard: ImportWizardState }>) {
  const { t } = useTranslation('scrapers')
  const ids = useId()
  const { outcome } = wizard
  if (outcome === null) return null
  return (
    <section className="card space-y-5" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="text-sm font-semibold text-text-strong">{t('importWizard.steps.insights')}</h2>
      <p className="text-sm text-text">{t('importWizard.insights.queued', { count: outcome.accepted })}</p>
      <Refusals outcome={outcome} />
      {outcome.accepted > 0 && <Figures outcome={outcome} />}
      <div className="flex flex-wrap gap-2">
        <Link className="btn btn-primary" to={dashboardPath(outcome)}>{t('importWizard.insights.openDashboard')}</Link>
        {outcome.formId !== undefined && (
          <Link className="btn btn-secondary" to={`/feedback-forms/${encodeURIComponent(outcome.formId)}/results`}>{t('importWizard.insights.openResults')}</Link>
        )}
        <button type="button" className="btn btn-secondary" onClick={wizard.reset}>{t('importWizard.insights.importAnother')}</button>
      </div>
    </section>
  )
}
