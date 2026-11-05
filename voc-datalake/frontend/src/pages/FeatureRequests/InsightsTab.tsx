/**
 * @fileoverview `/feature-requests?tab=insights`: the feedback boards as their own evidence source —
 * one board's figures, or every board's, over a window (30 / 90 / 365 days, all time). Totals, the
 * most-supported requests (each opens its detail on its board) and requests by category, status and
 * sentiment. An admin can enrich the requests not enriched yet.
 *
 * Board figures are never mixed into review metrics: this tab reads only
 * `GET /feature-requests/insights`.
 *
 * @module pages/FeatureRequests/InsightsTab
 */
import { Loader2, Sparkles, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { useSentimentLabels } from '../../components/DataSourceWizard/sentimentLabels'
import { formatCount } from '../../utils/numberFormat'
import { INSIGHT_WINDOWS, isInsightWindow } from '../../api/featureRequestInsights'
import InsightBars from './InsightBars'
import { insightStatusLabel } from './insightLabels'
import { useEnrichRequests, useInsights, useInsightsView } from './useInsights'
import type { InsightBarRow } from './InsightBars'
import type { InsightsView } from './useInsights'
import type { FeatureBoard } from '../../api/featureBoardsSchema'
import type { FeatureRequestInsights, InsightTopRequest } from '../../api/featureRequestInsightsSchema'

const requestLink = (requestId: string) => `/feature-requests?${new URLSearchParams({ request: requestId }).toString()}`

function WindowSelect({ value, onChange }: Readonly<{ value: InsightsView['days']; onChange: (days: InsightsView['days']) => void }>) {
  const { t } = useTranslation('featureRequests')
  return (
    <LabeledField label={t('insights.window')}>
      {(id) => (
        <select id={id} className="select w-auto" value={value}
          onChange={(e) => { const days = Number(e.target.value); if (isInsightWindow(days)) onChange(days) }}>
          {INSIGHT_WINDOWS.map((days) => (
            <option key={days} value={days}>{days === 0 ? t('insights.allTime') : t('insights.lastDays', { count: days })}</option>
          ))}
        </select>
      )}
    </LabeledField>
  )
}

function BoardSelect({ boards, value, onChange }: Readonly<{ boards: readonly FeatureBoard[]; value: string; onChange: (board: string) => void }>) {
  const { t } = useTranslation('featureRequests')
  return (
    <div className="min-w-48">
      <LabeledField label={t('insights.board')}>
        {(id) => (
          <select id={id} className="select w-full" value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">{t('insights.allBoards')}</option>
            {boards.map((board) => <option key={board.board_id} value={board.board_id}>{board.name}</option>)}
          </select>
        )}
      </LabeledField>
    </div>
  )
}

/** Admin: enrich the requests not enriched yet (a page per click), and what the last click queued. */
function EnrichButton({ board }: Readonly<{ board: string }>) {
  const { t } = useTranslation('featureRequests')
  const enrich = useEnrichRequests()
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" className="btn btn-secondary" disabled={enrich.isPending} onClick={() => enrich.mutate(board)}>
        {enrich.isPending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
        {t('insights.enrich')}
      </button>
      <p role="status" className="text-xs text-muted">
        {enrich.data ? t('insights.enrichQueued', { count: enrich.data.queued, remaining: enrich.data.remaining }) : null}
        {enrich.isError ? <span className="text-danger">{t('insights.enrichFailed')}</span> : null}
      </p>
    </div>
  )
}

function Totals({ totals }: Readonly<{ totals: FeatureRequestInsights['totals'] }>) {
  const { t, i18n } = useTranslation('featureRequests')
  const tiles = [
    { key: 'requests', label: t('insights.totalRequests'), value: totals.requests },
    { key: 'supporters', label: t('insights.totalSupporters'), value: totals.supporters },
    { key: 'enriched', label: t('insights.totalEnriched'), value: totals.enriched },
  ]
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="fr-insights-totals">
      {tiles.map((tile) => (
        <div key={tile.key} className="card p-4 min-w-0">
          <dt className="text-xs text-muted break-words">{tile.label}</dt>
          <dd className="text-2xl font-semibold text-text-strong font-mono">{formatCount(tile.value, i18n.language)}</dd>
        </div>
      ))}
    </dl>
  )
}

function TopRequests({ top, categoryLabel }: Readonly<{ top: readonly InsightTopRequest[]; categoryLabel: (id: string) => string }>) {
  const { t, i18n } = useTranslation('featureRequests')
  return (
    <section className="card p-4 space-y-3" aria-label={t('insights.top')}>
      <h3 className="text-sm font-medium text-text-strong">{t('insights.top')}</h3>
      {top.length === 0 ? <p className="text-sm text-muted">{t('insights.noData')}</p> : (
        <ol className="space-y-2" data-testid="fr-insights-top">
          {top.map((row) => (
            <li key={row.request_id} className="flex flex-wrap items-center justify-between gap-2 min-w-0">
              <Link to={requestLink(row.request_id)} className="link break-words min-w-0">{row.title === '' ? row.request_id : row.title}</Link>
              <span className="flex items-center gap-2 text-xs text-muted">
                {row.category === null ? null : <span className="badge badge-muted">{categoryLabel(row.category)}</span>}
                <span className="inline-flex items-center gap-1 font-mono" title={t('insights.totalSupporters')}>
                  <Users size={12} aria-hidden="true" />{formatCount(row.supporters, i18n.language)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** The three breakdowns as chart rows, in words. */
function useBreakdowns(insights: FeatureRequestInsights, boards: readonly FeatureBoard[]) {
  const { t } = useTranslation('featureRequests')
  const labels = useDisplayLabels()
  const sentiments = useSentimentLabels()
  const uncategorized = t('insights.uncategorized')
  const byCategory: InsightBarRow[] = insights.by_category.map((row) => ({
    key: row.category ?? '', name: row.category === null ? uncategorized : labels.category(row.category), value: row.requests,
  }))
  const byStatus: InsightBarRow[] = insights.by_status.map((row) => ({
    key: row.status, name: insightStatusLabel(row.status, boards, t), value: row.requests,
  }))
  const bySentiment: InsightBarRow[] = insights.by_sentiment.map((row) => ({
    key: row.sentiment ?? '', name: row.sentiment === null ? t('insights.notEnriched') : sentiments[row.sentiment], value: row.requests,
  }))
  return { byCategory, byStatus, bySentiment, categoryLabel: labels.category }
}

function InsightsBody({ insights, boards }: Readonly<{ insights: FeatureRequestInsights; boards: readonly FeatureBoard[] }>) {
  const { t } = useTranslation('featureRequests')
  const { byCategory, byStatus, bySentiment, categoryLabel } = useBreakdowns(insights, boards)
  if (insights.totals.requests === 0) return <p className="card p-6 text-sm text-muted" data-testid="fr-insights-empty">{t('insights.empty')}</p>
  return (
    <div className="space-y-4">
      <Totals totals={insights.totals} />
      {insights.truncated ? <p className="text-xs text-muted" data-testid="fr-insights-truncated">{t('insights.truncated')}</p> : null}
      <TopRequests top={insights.top} categoryLabel={categoryLabel} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <InsightBars title={t('insights.byCategory')} rows={byCategory} fill="var(--chart-1)" testId="fr-insights-by-category" />
        <InsightBars title={t('insights.byStatus')} rows={byStatus} fill="var(--chart-2)" testId="fr-insights-by-status" />
        <InsightBars title={t('insights.bySentiment')} rows={bySentiment} fill="var(--chart-3)" testId="fr-insights-by-sentiment" />
      </div>
    </div>
  )
}

/** `boards` = the boards this person may use (the page's own listing); archived ones are not offered. */
export default function InsightsTab({ boards, isAdmin }: Readonly<{ boards: readonly FeatureBoard[]; isAdmin: boolean }>) {
  const { t } = useTranslation('featureRequests')
  const [view, setView] = useInsightsView()
  const offered = boards.filter((board) => !board.archived)
  // A board in the URL that this person cannot pick (archived, gone, not theirs) reads as every board.
  const board = offered.some((candidate) => candidate.board_id === view.board) ? view.board : ''
  const query = useInsights({ ...view, board })
  const shownBoards = board === '' ? offered : offered.filter((candidate) => candidate.board_id === board)
  return (
    <section className="space-y-4" aria-label={t('insights.label')}>
      <p className="text-sm text-muted">{t('insights.intro')}</p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <BoardSelect boards={offered} value={board} onChange={(next) => setView({ board: next })} />
          <WindowSelect value={view.days} onChange={(days) => setView({ days })} />
        </div>
        {isAdmin ? <EnrichButton board={board} /> : null}
      </div>
      {query.isLoading ? <p className="text-sm text-muted">{t('loading')}</p> : null}
      {query.isError ? <LoadFailed message={t('insights.loadFailed')} onRetry={() => { void query.refetch() }} retrying={query.isFetching} /> : null}
      {query.data ? <InsightsBody insights={query.data} boards={shownBoards} /> : null}
    </section>
  )
}
