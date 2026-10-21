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

import { useState } from 'react'
import clsx from 'clsx'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, BarChart, Bar } from 'recharts'
import { MessageSquare, TrendingUp, AlertTriangle, Users, Zap, FileDown } from 'lucide-react'
import { getDateRangeParams } from '../../api/client'
import type { MetricsSummary, SentimentBreakdown, CategoryBreakdown, SourceBreakdown, FeedbackItem } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { usePageFilters } from '../../store/feedbackFilterStore'
import { filtersKey } from '../../api/feedbackFilters'
import { FILTER_QUERY_DEBOUNCE_MS, useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useSettledOnce } from '../../hooks/useSettledOnce'
import MetricCard from '../../components/MetricCard'
import FeedbackCard from '../../components/FeedbackCard'
import SocialFeed from '../../components/SocialFeed'
import FeedbackFilterPanel from '../../components/FeedbackFilterPanel'
import FeedbackDetailOverlay from '../../components/FeedbackDetailOverlay'
import { generateDashboardPDF } from './dashboardPdfGenerator'
import { getTimeRangeLabel } from '../../utils/dateUtils'
import { useTranslation } from 'react-i18next'
import DashboardEmptyState from './DashboardEmptyState'
import EmptyWindowBanner from '../../components/EmptyWindowBanner'
import { useCustomFilterControls } from '../Categories/useCustomFilterControls'
import { URGENT_PREVIEW_LIMIT, useDashboardData } from './useDashboardData'
import type { DashboardData } from './useDashboardData'

const COLORS = ['#22c55e', '#6b7280', '#ef4444', '#eab308']

/**
 * Count for the "Urgent Issues (N)" heading.
 *
 * The heading and the list beneath it come from different sources: the exact
 * `METRIC#urgent` aggregate (via /metrics/summary) and a windowed scan (via
 * /feedback/urgent). They can disagree when aggregates are missing, stale, or
 * bounded differently — and the aggregate can legitimately read 0 while the scan
 * still returns items, so a nullish fallback would not catch it (0 is not
 * nullish).
 *
 * Taking the larger value holds two invariants at once: never understate the
 * total (reporting the page size was the original defect), and never claim fewer
 * items than are visibly rendered.
 */
function urgentHeadingCount(aggregateTotal: number | undefined, previewLength: number | undefined): number {
  return Math.max(aggregateTotal ?? 0, previewLength ?? 0)
}

function NotConfiguredState() {
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-center max-w-md">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Welcome to VoC Analytics</h2>
        <p className="text-gray-600 mb-6">
          Configure your API endpoint and brand settings to start analyzing customer feedback.
        </p>
        <a href="/settings" className="btn btn-primary">
          Go to Settings
        </a>
      </div>
    </div>
  )
}

function LoadingState() {
  return <div className="flex items-center justify-center h-full">Loading...</div>
}

interface MetricsGridProps {
  summary: MetricsSummary | undefined
  sourcesCount: number
}

function MetricsGrid({ summary, sourcesCount }: Readonly<MetricsGridProps>) {
  // 'common', matching the namespace this file already reads, and where the
  // sibling partial-window copy lives (`partialWindowHint`, used by the
  // Categories results line): the hint is about counts being a lower bound, not
  // about the dashboard.
  const { t } = useTranslation('common')
  const avgSentiment = summary ? Number(summary.avg_sentiment) : 0
  const sentimentTrend = avgSentiment > 0 ? 'up' : 'down'
  const sentimentColor = avgSentiment > 0 ? 'green' : 'red'
  // The route reports this on BOTH of its paths now, so the hint names neither
  // cause — see `MetricsSummary.is_partial` in api/types.ts for the three of
  // them. Whichever fired, the counts are a lower bound and the cards must say
  // so instead of looking exact.
  const isPartial = summary?.is_partial ?? false
  const partialHint = isPartial ? t('partialCountsHint') : undefined
  const approx = (n: number | string) => (isPartial ? `~${n}` : n)

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      <MetricCard
        title="Total Feedback"
        value={approx(summary?.total_feedback.toLocaleString() || 0)}
        icon={<MessageSquare size={24} />}
        color="blue"
        hint={partialHint}
      />
      <MetricCard
        title="Avg Sentiment"
        value={avgSentiment.toFixed(2)}
        icon={<TrendingUp size={24} />}
        color={sentimentColor}
        trend={sentimentTrend}
      />
      <MetricCard
        title="Urgent Issues"
        value={approx(summary?.urgent_count || 0)}
        icon={<AlertTriangle size={24} />}
        color="orange"
        hint={partialHint}
      />
      <MetricCard
        title="Sources Active"
        value={sourcesCount}
        icon={<Users size={24} />}
        color="gray"
      />
    </div>
  )
}

interface TrendChartProps {
  dailyTotals: Array<{ date: string; count: number }> | undefined
}

function TrendChart({ dailyTotals }: Readonly<TrendChartProps>) {
  const sortedData = [...(dailyTotals || [])].sort((a, b) => a.date.localeCompare(b.date))

  return (
    <div className="card !p-4 sm:!p-6">
      <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Feedback Volume & Sentiment Trend</h3>
      <div className="h-[200px] sm:h-[300px] -mx-2 sm:mx-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={sortedData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10 }} width={35} />
            <Tooltip />
            <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function prepareSentimentPieData(sentiment: SentimentBreakdown | undefined) {
  if (!sentiment) return []
  return [
    { name: 'Positive', value: sentiment.breakdown.positive || 0, fill: COLORS[0] },
    { name: 'Neutral', value: sentiment.breakdown.neutral || 0, fill: COLORS[1] },
    { name: 'Negative', value: sentiment.breakdown.negative || 0, fill: COLORS[2] },
    { name: 'Mixed', value: sentiment.breakdown.mixed || 0, fill: COLORS[3] },
  ].filter(d => d.value > 0)
}

interface SentimentChartProps {
  sentiment: SentimentBreakdown | undefined
}

function SentimentChart({ sentiment }: Readonly<SentimentChartProps>) {
  const pieData = prepareSentimentPieData(sentiment)

  return (
    <div className="card !p-4 sm:!p-6">
      <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Sentiment Distribution</h3>
      <div className="h-[200px] sm:h-[300px]">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              innerRadius="40%"
              outerRadius="70%"
              paddingAngle={2}
              dataKey="value"
              label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
              labelLine={{ strokeWidth: 1 }}
            >
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function prepareCategoryData(categories: CategoryBreakdown | undefined) {
  if (!categories) return []
  return Object.entries(categories.categories)
    .slice(0, 8)
    .map(([name, value]) => ({ name, value }))
}

interface CategoryChartProps {
  categories: CategoryBreakdown | undefined
}

function CategoryChart({ categories }: Readonly<CategoryChartProps>) {
  const barData = prepareCategoryData(categories)

  return (
    <div className="card !p-4 sm:!p-6">
      <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Top Issue Categories</h3>
      <div className="h-[250px] sm:h-[300px] -mx-2 sm:mx-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={barData} layout="vertical" margin={{ left: 0, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis type="number" tick={{ fontSize: 10 }} />
            <YAxis dataKey="name" type="category" tick={{ fontSize: 10 }} width={80} />
            <Tooltip />
            <Bar dataKey="value" fill="#3b82f6" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function prepareSourceData(sources: SourceBreakdown | undefined) {
  if (!sources) return []
  return Object.entries(sources.sources)
    .map(([name, value]) => ({ name: name.replace('_', ' '), value }))
}

interface SourceChartProps {
  sources: SourceBreakdown | undefined
}

function SourceChart({ sources }: Readonly<SourceChartProps>) {
  const barData = prepareSourceData(sources)

  return (
    <div className="card !p-4 sm:!p-6">
      <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Feedback by Source</h3>
      <div className="h-[250px] sm:h-[300px] -mx-2 sm:mx-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={barData} margin={{ left: 0, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-45} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 10 }} width={35} />
            <Tooltip />
            <Bar dataKey="value" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

interface UrgentFeedbackProps {
  items: FeedbackItem[] | undefined
  /**
   * Exact urgent total for the window, from /metrics/summary's `urgent_count`.
   * Deliberately not the preview list's `count`, which is that page's length and
   * is clamped by the limit it was fetched with. The heading is reconciled
   * against the rendered items by `urgentHeadingCount`.
   */
  aggregateTotal: number | undefined
  /** Opens an item in the detail pop-up. */
  onOpen?: (item: FeedbackItem) => void
}

function UrgentFeedback({ items, aggregateTotal, onOpen }: Readonly<UrgentFeedbackProps>) {
  const hasItems = items && items.length > 0
  const count = urgentHeadingCount(aggregateTotal, items?.length)

  return (
    <div className="card !p-4 sm:!p-6">
      <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4 flex items-center gap-2">
        <AlertTriangle className="text-orange-500 flex-shrink-0" size={20} />
        <span>Urgent Issues ({count})</span>
      </h3>
      {hasItems ? (
        <div className="space-y-3 max-h-[400px] sm:max-h-[600px] overflow-y-auto">
          {items.slice(0, URGENT_PREVIEW_LIMIT).map((item) => (
            <FeedbackCard key={item.feedback_id} feedback={item} compact onOpen={onOpen} />
          ))}
        </div>
      ) : (
        <div className="text-center py-6 sm:py-8 text-gray-500">
          No urgent issues - great job! 🎉
        </div>
      )}
    </div>
  )
}

interface PDFExportInput {
  summary: MetricsSummary | undefined
  sentiment: SentimentBreakdown | undefined
  categories: CategoryBreakdown | undefined
  sources: SourceBreakdown | undefined
  urgentFeedback: { items?: FeedbackItem[]; count?: number } | undefined
  timeRange: string
  sourcesCount: number
}

function buildSentimentEntries(sentiment: SentimentBreakdown | undefined) {
  if (!sentiment) return []
  return Object.entries(sentiment.breakdown)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }))
}

function buildCategoryEntries(categories: CategoryBreakdown | undefined) {
  if (!categories) return []
  return Object.entries(categories.categories)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([name, value]) => ({ name, value }))
}

function buildPDFExportData(input: PDFExportInput) {
  return {
    timeRange: input.timeRange,
    totalFeedback: input.summary?.total_feedback ?? 0,
    avgSentiment: input.summary ? Number(input.summary.avg_sentiment) : 0,
    urgentCount: input.summary?.urgent_count ?? 0,
    sourcesCount: input.sourcesCount,
    dailyTotals: input.summary?.daily_totals ?? [],
    sentimentBreakdown: buildSentimentEntries(input.sentiment),
    categoryBreakdown: buildCategoryEntries(input.categories),
    sourceBreakdown: prepareSourceData(input.sources),
    urgentItems: input.urgentFeedback?.items ?? [],
  }
}

/**
 * A filtered window with no rows. When the scan itself FAILED the counts are
 * unknown, so say that (with a retry) instead of claiming nothing matches.
 */
function FilteredEmptyState({ loadFailed, onRetry }: Readonly<{ loadFailed: boolean; onRetry: () => void }>) {
  const { t } = useTranslation('common')
  if (loadFailed) {
    return (
      <div className="card text-center py-10" role="alert">
        <p className="text-gray-700 font-medium">{t('feedbackFilters.loadFailed')}</p>
        <button type="button" onClick={onRetry} className="btn btn-secondary text-sm mt-3">
          {t('feedbackFilters.retry')}
        </button>
      </div>
    )
  }
  return (
    <div className="card text-center py-10" role="status">
      <p className="text-gray-700 font-medium">{t('feedbackFilters.noMatches')}</p>
      <p className="text-sm text-gray-500 mt-1">{t('feedbackFilters.noMatchesHint')}</p>
    </div>
  )
}

function ExportPdfButton({ onExport }: Readonly<{ onExport: () => void }>) {
  const { t } = useTranslation('common')
  return (
    <button
      onClick={onExport}
      className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 whitespace-nowrap"
      title={t('exportPdfTooltip')}
    >
      <FileDown size={14} />
      {t('exportPdf')}
    </button>
  )
}

interface DashboardContentProps {
  readonly data: DashboardData
  readonly isEmpty: boolean
  /** Showing an earlier selection's results while the current one loads. */
  readonly isUpdating: boolean
  readonly onOpenFeedback: (item: FeedbackItem) => void
}

/**
 * Everything under the filter panel. Re-queries render HERE, never by replacing
 * the page, so the panel stays mounted (open, focused) across several changes.
 */
function DashboardContent({ data, isEmpty, isUpdating, onOpenFeedback }: DashboardContentProps) {
  // An empty earlier result is no answer for the new selection: wait for it.
  if (data.isLoading || (isEmpty && isUpdating)) return <LoadingState />
  if (isEmpty) return <FilteredEmptyState loadFailed={data.loadFailed} onRetry={data.retry} />
  return (
    <div aria-busy={isUpdating} className={clsx('space-y-4 sm:space-y-6 transition-opacity', isUpdating && 'opacity-60')}>
      <DashboardBody data={data} onOpenFeedback={onOpenFeedback} />
    </div>
  )
}

function DashboardBody({ data, onOpenFeedback }: Readonly<{ data: DashboardData; onOpenFeedback: (item: FeedbackItem) => void }>) {
  const { summary, sentiment, categories, sources } = data
  const sourcesCount = Object.keys(sources?.sources || {}).length
  return (
    <>
      <MetricsGrid summary={summary} sourcesCount={sourcesCount} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <TrendChart dailyTotals={summary?.daily_totals} />
        <SentimentChart sentiment={sentiment} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <CategoryChart categories={categories} />
        <SourceChart sources={sources} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <div className="card !p-4 sm:!p-6">
          <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4 flex items-center gap-2">
            <Zap className="text-blue-500 flex-shrink-0" size={20} />
            Live Social Feed
          </h3>
          <SocialFeed limit={8} showFilters={true} />
        </div>
        <UrgentFeedback items={data.urgentItems} aggregateTotal={summary?.urgent_count} onOpen={onOpenFeedback} />
      </div>
    </>
  )
}

export default function Dashboard() {
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)
  const { filters, setFilters } = usePageFilters('dashboard')
  const [openFeedback, setOpenFeedback] = useState<FeedbackItem | null>(null)
  // The panel shows `filters` instantly; the queries follow once the user pauses,
  // so several quick changes cost one scan.
  const queryFilters = useDebouncedValue(filters, FILTER_QUERY_DEBOUNCE_MS)
  const data = useDashboardData(dateParams, dateBasis, config.apiEndpoint, queryFilters)
  const settled = useSettledOnce(data.isLoading)
  const customFilterControls = useCustomFilterControls(config.apiEndpoint)
  const isUpdating = data.isUpdating || filtersKey(filters) !== filtersKey(queryFilters)

  if (!config.apiEndpoint) {
    return <NotConfiguredState />
  }

  // Full-page spinner for the FIRST load only (the selected window, the fallback
  // probe, or a remembered filter's first scan), so the empty prompt never
  // flashes first. Later loads render inside DashboardContent.
  if (!settled) {
    return <LoadingState />
  }

  const isEmpty = (data.summary?.total_feedback ?? 0) === 0
  // Genuinely no data anywhere → the onboarding prompt. A filtered window that
  // matches nothing keeps the page (and its panel) so the filters can be changed.
  if (isEmpty && !data.isFiltered && !data.isLoading && !isUpdating) {
    return <DashboardEmptyState />
  }

  const exportPDF = () => {
    try {
      generateDashboardPDF(buildPDFExportData({
        summary: data.summary,
        sentiment: data.sentiment,
        categories: data.categories,
        sources: data.sources,
        urgentFeedback: { items: data.urgentItems },
        timeRange: getTimeRangeLabel(timeRange, customDays, dateBasis),
        sourcesCount: Object.keys(data.sources?.sources || {}).length,
      }))
    } catch {
      // PDF generation is best-effort (e.g. popup blocked)
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {data.fallback ? <EmptyWindowBanner date={data.fallback.latestDate} /> : null}
      <FeedbackFilterPanel
        filters={filters}
        onChange={setFilters}
        options={{
          sources: Object.keys(data.optionCounts.sources),
          categories: Object.keys(data.optionCounts.categories),
        }}
        counts={data.optionCounts}
        customFilterControls={customFilterControls}
        trailing={<ExportPdfButton onExport={exportPDF} />}
        isUpdating={isUpdating}
      />
      <DashboardContent data={data} isEmpty={isEmpty} isUpdating={isUpdating} onOpenFeedback={setOpenFeedback} />
      <FeedbackDetailOverlay feedback={openFeedback} onClose={() => setOpenFeedback(null)} />
    </div>
  )
}
