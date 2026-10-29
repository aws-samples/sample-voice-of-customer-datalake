/**
 * @fileoverview Dashboard page - main overview of VoC analytics.
 *
 * Displays key metrics, charts, and urgent feedback items:
 * - Total feedback count, average sentiment, urgent issues
 * - Sentiment trend line chart over time
 * - Category and source distribution pie/bar charts
 * - Live social feed and urgent feedback cards
 *
 * @module pages/Dashboard
 */

import { useQuery } from '@tanstack/react-query'
import { Zap, FileDown } from 'lucide-react'
import { Link } from 'react-router-dom'
import { accountTabPath } from '../Account/accountSections'
import { api, getDateRangeParams } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import SocialFeed from '../../components/SocialFeed/SocialFeed'
import { generateDashboardPDF } from './dashboardPdfGenerator'
import { activeSourceCount, buildPDFExportData } from './dashboardData'
import { MetricsGrid, SentimentChart, UrgentFeedback, URGENT_PREVIEW_LIMIT } from './DashboardSections'
import PartialCountsNote from './PartialCountsNote'
import DashboardCard from './DashboardCard'
import GitHubInsights from './GitHubInsights'
import DimensionBreakdown from './DimensionBreakdown'
import { CategoryChart, SourceChart, TrendChart } from './DashboardCharts'
import { getTimeRangeLabel } from '../../utils/dateUtils'
import { useTranslation } from 'react-i18next'
import DashboardWindowEmpty from './DashboardWindowEmpty'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import ScopeNotice from '../../components/ScopeNotice/ScopeNotice'
import { failedReads, type FailedReads } from '../../utils/failedReads'
import { useSummaryQuery } from '../../hooks/useSummaryQuery'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { metricsKeys } from '../../api/queryKeys'

function NotConfiguredState() {
  const { t } = useTranslation(['dashboard', 'common'])
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-center max-w-md">
        <h1 className="text-2xl font-bold tracking-tight text-text-strong mb-2">{t('welcome')}</h1>
        <p className="text-sm text-muted mb-6">{t('welcomeDescription')}</p>
        <Link to={accountTabPath('preferences')} className="btn btn-primary">
          {t('common:goToSettings')}
        </Link>
      </div>
    </div>
  )
}

function LoadingState() {
  const { t } = useTranslation(['dashboard', 'common'])
  return (
    <div className="flex items-center justify-center h-full" role="status">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" aria-hidden="true" />
      <span className="sr-only">{t('common:loading')}</span>
    </div>
  )
}

/** The page title over a LoadFailed: the summary read failed, which is not "no feedback". */
function SummaryLoadFailed({ failure }: Readonly<{ failure: FailedReads }>) {
  const { t } = useTranslation('dashboard')
  return (
    <div className="space-y-4 sm:space-y-6">
      <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-text-strong">{t('title')}</h1>
      <LoadFailed onRetry={failure.retry} retrying={failure.retrying} />
    </div>
  )
}

export default function Dashboard() {
  const { t } = useTranslation(['common', 'dashboard'])
  const labels = useDisplayLabels()
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)
  const isConfigured = !!config.apiEndpoint

  // Shared with the sidebar urgent badge via useSummaryQuery so the two cannot
  // resolve to different cache entries (see that module).
  // Takes the endpoint rather than `isConfigured`: the hook owns both the query
  // key and its enabling condition, so callers cannot make them disagree.
  const summaryQuery = useSummaryQuery(dateParams, config.apiEndpoint)
  const { data: summary, isLoading: summaryLoading } = summaryQuery
  const summaryFailure = failedReads([summaryQuery])

  const { data: sentiment } = useQuery({
    queryKey: metricsKeys.sentiment(dateParams),
    queryFn: () => api.getSentiment(dateParams),
    enabled: isConfigured,
  })

  const { data: categories } = useQuery({
    queryKey: metricsKeys.categories(dateParams),
    queryFn: () => api.getCategories(dateParams),
    enabled: isConfigured,
  })

  const { data: sources } = useQuery({
    queryKey: metricsKeys.sources(dateParams),
    queryFn: () => api.getSources(dateParams),
    enabled: isConfigured,
  })

  // `limit` MUST stay in the query key: /feedback/urgent returns a different
  // payload per limit, so a key that omits it lets two callers with different
  // limits collide on one cache entry (which is how the sidebar badge used to
  // render this list's page size).
  const { data: urgentFeedback } = useQuery({
    queryKey: ['urgent', dateParams, URGENT_PREVIEW_LIMIT],
    queryFn: () => api.getUrgentFeedback({ ...dateParams, limit: URGENT_PREVIEW_LIMIT }),
    enabled: isConfigured,
  })

  if (!isConfigured) {
    return <NotConfiguredState />
  }

  if (summaryLoading) {
    return <LoadingState />
  }

  // A failed summary read is not "no feedback": without this, offline / 500 /
  // 403 fell through to the empty-window state below and told the user their
  // workspace had nothing in it (e2e error-states.spec.ts).
  if (summaryFailure.loadFailed) {
    return <SummaryLoadFailed failure={summaryFailure} />
  }

  // No feedback in this range: DashboardWindowEmpty checks the all-time total
  // and shows the welcome state only when the workspace truly has none, else
  // the newest feedback date with a one-click "Show all time" (E2E F4).
  if ((summary?.total_feedback ?? 0) === 0) {
    return <DashboardWindowEmpty dateParams={dateParams} apiEndpoint={config.apiEndpoint} loading={<LoadingState />} />
  }

  const sourcesCount = activeSourceCount(sources)

  const exportPDF = () => {
    try {
      generateDashboardPDF(buildPDFExportData({
        summary,
        sentiment,
        categories,
        sources,
        urgentFeedback,
        timeRange: getTimeRangeLabel(timeRange, customDays, dateBasis),
        sourcesCount,
        labels,
      }))
    } catch {
      // PDF generation is best-effort (e.g. popup blocked)
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-text-strong">{t('dashboard:title')}</h1>
          <p className="text-sm text-muted mt-1">{t('dashboard:subtitle')}</p>
          <ScopeNotice className="mt-2" />
        </div>
        <button
          type="button"
          onClick={exportPDF}
          className="btn btn-secondary btn-sm self-start sm:self-auto"
          title={t('common:exportPdfTooltip')}
        >
          <FileDown size={14} aria-hidden="true" />
          {t('common:exportPdf')}
        </button>
      </div>

      <MetricsGrid summary={summary} sentiment={sentiment} activeSources={sourcesCount} />
      <PartialCountsNote summary={summary} dateBasis={dateBasis} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <TrendChart summary={summary} />
        <SentimentChart sentiment={sentiment} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <CategoryChart categories={categories} />
        <SourceChart sources={sources} />
      </div>

      <GitHubInsights dateParams={dateParams} sources={sources} />

      <DimensionBreakdown dateParams={dateParams} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 items-start">
        <DashboardCard
          icon={<Zap className="text-accent-text flex-shrink-0" size={18} aria-hidden="true" />}
          title={t('dashboard:liveSocialFeed')}
        >
          <SocialFeed limit={8} showFilters={true} />
        </DashboardCard>
        <UrgentFeedback items={urgentFeedback?.items} aggregateTotal={summary?.urgent_count} />
      </div>
    </div>
  )
}
