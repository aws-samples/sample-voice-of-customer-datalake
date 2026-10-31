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

import { Zap, FileDown } from 'lucide-react'
import { Link } from 'react-router-dom'
import { accountTabPath } from '../Account/accountSections'
import { getDateRangeParams } from '../../api/client'
import type { DateRangeParams } from '../../api/client'
import type { DateBasis } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import SocialFeed from '../../components/SocialFeed/SocialFeed'
import { generateDashboardPDF } from './dashboardPdfGenerator'
import { activeSourceCount, buildPDFExportData } from './dashboardData'
import { MetricsGrid, SentimentChart, UrgentFeedback } from './DashboardSections'
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
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { hasActiveFacets } from '../../api/feedbackFacets'
import { useFacetParams } from '../../hooks/useFacetParams'
import { useDashboardData } from './useDashboardData'
import { DashboardFilters, FilteredEmpty } from './DashboardFilters'

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

interface DashboardBodyProps {
  readonly dateParams: DateRangeParams
  readonly dateBasis: DateBasis
  readonly data: ReturnType<typeof useDashboardData>
  readonly sourcesCount: number
}

/** The cards, charts and lists (the filtered reads; the GitHub, dimension and social cards are unfiltered). */
function DashboardBody({ dateParams, dateBasis, data, sourcesCount }: DashboardBodyProps) {
  const { t } = useTranslation('dashboard')
  const { summaryQuery: { data: summary }, sentiment, categories, sources, urgentFeedback } = data
  return (
    <>
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
          title={t('liveSocialFeed')}
        >
          <SocialFeed limit={8} showFilters={true} />
        </DashboardCard>
        <UrgentFeedback items={urgentFeedback?.items} aggregateTotal={summary?.urgent_count} />
      </div>
    </>
  )
}

export default function Dashboard() {
  const { t } = useTranslation(['common', 'dashboard'])
  const labels = useDisplayLabels()
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)
  const isConfigured = !!config.apiEndpoint

  // The facet filters live in the URL (`?source=a,b&usefulness=high`). With none set, every
  // read is the unfiltered one: the summary shares the sidebar badge's cache entry
  // (useSummaryQuery), so the badge and the "Urgent Issues" card cannot disagree.
  const facetParams = useFacetParams()
  const filtered = hasActiveFacets(facetParams.facets)
  const data = useDashboardData(dateParams, config.apiEndpoint, facetParams.facets)
  const { summaryQuery, sentiment, categories, sources, urgentFeedback } = data
  const { data: summary, isLoading: summaryLoading } = summaryQuery
  const summaryFailure = failedReads([summaryQuery])

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
  // A FILTERED window with nothing in it keeps the page and its filters (DashboardFilters).
  if (!filtered && (summary?.total_feedback ?? 0) === 0) {
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

      <DashboardFilters params={facetParams} sourceOptions={data.sourceOptions} categoryOptions={data.categoryOptions} />

      {(summary?.total_feedback ?? 0) === 0
        ? <FilteredEmpty onClear={facetParams.clearAll} />
        : <DashboardBody dateParams={dateParams} dateBasis={dateBasis} data={data} sourcesCount={sourcesCount} />}
    </div>
  )
}
