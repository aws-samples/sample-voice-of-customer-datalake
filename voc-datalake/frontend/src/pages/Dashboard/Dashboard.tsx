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
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, BarChart, Bar } from 'recharts'
import { MessageSquare, TrendingUp, AlertTriangle, Users, Zap, FileDown, CheckCircle2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api, getDateRangeParams } from '../../api/client'
import type { MetricsSummary, SentimentBreakdown, CategoryBreakdown, SourceBreakdown, FeedbackItem } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import MetricCard from '../../components/MetricCard/MetricCard'
import FeedbackCard from '../../components/FeedbackCard/FeedbackCard'
import SocialFeed from '../../components/SocialFeed/SocialFeed'
import { generateDashboardPDF } from './dashboardPdfGenerator'
import { buildPDFExportData, partialHintText, prepareSourceData } from './dashboardData'
import DashboardCard from './DashboardCard'
import GitHubInsights from './GitHubInsights'
import DimensionBreakdown from './DimensionBreakdown'
import { AXIS_LINE, AXIS_TICK, BAR_CURSOR, CHART_CONTAINER_PROPS, GRID_STROKE, LINE_CURSOR, TOOLTIP_PROPS } from './chartTheme'
import { getTimeRangeLabel } from '../../utils/dateUtils'
import { useTranslation } from 'react-i18next'
import { readPartialWindow } from '../../api/partialWindow'
import DashboardWindowEmpty from './DashboardWindowEmpty'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { failedReads, type FailedReads } from '../../utils/failedReads'
import { useSummaryQuery } from '../../hooks/useSummaryQuery'

// Theme tokens (src/index.css) — flip with light/dark. Order matches
// prepareSentimentPieData: positive, neutral, negative, mixed.
const COLORS = [
  'var(--sentiment-positive)',
  'var(--sentiment-neutral)',
  'var(--sentiment-negative)',
  'var(--sentiment-mixed)',
]

/** `customer_support` → `Customer support` (axis ticks, legend labels). */
function humanize(name: string): string {
  const spaced = name.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * How many urgent items the dashboard previews. The list is a preview, not the
 * full set — the heading reports the true total from /metrics/summary, so this
 * number must never be presented as a count.
 */
const URGENT_PREVIEW_LIMIT = 5

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
  const { t } = useTranslation(['dashboard', 'common'])
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-center max-w-md">
        <h1 className="text-2xl font-bold tracking-tight text-text-strong mb-2">{t('welcome')}</h1>
        <p className="text-sm text-muted mb-6">{t('welcomeDescription')}</p>
        <Link to="/admin" className="btn btn-primary">
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

interface MetricsGridProps {
  summary: MetricsSummary | undefined
  sourcesCount: number
}

function MetricsGrid({ summary, sourcesCount }: Readonly<MetricsGridProps>) {
  // `partialCountsHint` lives in 'common' next to the sibling partial-window
  // copy (`partialWindowHint`, used by the Categories results line): the hint is
  // about counts being a lower bound, not about the dashboard.
  const { t } = useTranslation(['dashboard', 'common'])
  const avgSentiment = summary ? Number(summary.avg_sentiment) : 0
  const sentimentTrend = avgSentiment > 0 ? 'up' : 'down'
  const sentimentColor = avgSentiment > 0 ? 'ok' : 'danger'
  // The route reports this on BOTH of its paths now, so the hint names neither
  // cause — see `MetricsSummary.is_partial` in api/types.ts for the three of
  // them. Whichever fired, the counts are a lower bound and the cards must say
  // so instead of looking exact.
  const { isPartial, scannedThrough } = readPartialWindow(summary)
  const partialHint = partialHintText(isPartial, scannedThrough, t)
  const approx = (n: number | string) => (isPartial ? `~${n}` : n)

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      <MetricCard
        title={t('metrics.totalFeedback')}
        value={approx(summary?.total_feedback.toLocaleString() ?? 0)}
        icon={<MessageSquare size={24} />}
        color="accent"
        hint={partialHint}
      />
      <MetricCard
        title={t('metrics.avgSentiment')}
        value={avgSentiment.toFixed(2)}
        icon={<TrendingUp size={24} />}
        color={sentimentColor}
        trend={sentimentTrend}
      />
      <MetricCard
        title={t('metrics.urgentIssues')}
        // Grouped like Total Feedback beside it ("11,268", not "11268").
        value={approx((summary?.urgent_count ?? 0).toLocaleString())}
        icon={<AlertTriangle size={24} />}
        color="warn"
        hint={partialHint}
      />
      <MetricCard
        title={t('metrics.sourcesActive')}
        value={sourcesCount}
        icon={<Users size={24} />}
        color="muted"
      />
    </div>
  )
}

interface TrendChartProps {
  dailyTotals: Array<{ date: string; count: number }> | undefined
}

function TrendChart({ dailyTotals }: Readonly<TrendChartProps>) {
  const { t } = useTranslation('dashboard')
  const sortedData = [...(dailyTotals ?? [])].sort((a, b) => a.date.localeCompare(b.date))

  return (
    <DashboardCard title={t('feedbackVolumeTrend')}>
      <div className="h-[200px] sm:h-[300px] -mx-2 sm:mx-0">
        <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
          <LineChart data={sortedData}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="date" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} interval="preserveStartEnd" />
            <YAxis tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={35} />
            <Tooltip {...TOOLTIP_PROPS} cursor={LINE_CURSOR} />
            <Line type="monotone" dataKey="count" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </DashboardCard>
  )
}

type SentimentKey = 'positive' | 'neutral' | 'negative' | 'mixed'
const SENTIMENT_ORDER: readonly SentimentKey[] = ['positive', 'neutral', 'negative', 'mixed']

function prepareSentimentPieData(sentiment: SentimentBreakdown | undefined) {
  if (!sentiment) return []
  return SENTIMENT_ORDER
    // A label absent from the breakdown is 0 and, like a present 0, filtered out below.
    .map((key, i) => ({ key, value: sentiment.breakdown[key] ?? 0, fill: COLORS[i] }))
    .filter(d => d.value > 0)
}

interface SentimentChartProps {
  sentiment: SentimentBreakdown | undefined
}

/**
 * Donut plus a chip legend. The legend replaces Recharts' outer slice labels,
 * which were clipped by the card at most widths and unreadable on mobile.
 */
function SentimentChart({ sentiment }: Readonly<SentimentChartProps>) {
  const { t } = useTranslation('dashboard')
  const pieData = prepareSentimentPieData(sentiment).map(d => ({ ...d, name: t(`sentiment.${d.key}`) }))
  const total = pieData.reduce((sum, d) => sum + d.value, 0)

  return (
    <DashboardCard title={t('sentimentDistribution')}>
      <div className="h-[180px] sm:h-[250px]">
        <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={2}
              dataKey="value"
              nameKey="name"
              stroke="var(--card)"
            />
            <Tooltip {...TOOLTIP_PROPS} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-3 flex flex-wrap justify-center gap-1.5">
        {pieData.map(d => (
          <li key={d.key} className="inline-flex items-center gap-1.5 rounded-full bg-bg-hover px-2.5 py-1 text-xs text-text">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.fill }} aria-hidden="true" />
            {d.name}
            <span className="font-mono text-muted">{total > 0 ? ((d.value / total) * 100).toFixed(0) : 0}%</span>
          </li>
        ))}
      </ul>
    </DashboardCard>
  )
}

function prepareCategoryData(categories: CategoryBreakdown | undefined) {
  if (!categories) return []
  return Object.entries(categories.categories)
    .slice(0, 8)
    .map(([name, value]) => ({ name: humanize(name), value }))
}

interface CategoryChartProps {
  categories: CategoryBreakdown | undefined
}

function CategoryChart({ categories }: Readonly<CategoryChartProps>) {
  const { t } = useTranslation('dashboard')
  const barData = prepareCategoryData(categories)

  return (
    <DashboardCard title={t('topIssueCategories')}>
      <div className="h-[250px] sm:h-[300px] -mx-2 sm:mx-0">
        <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
          <BarChart data={barData} layout="vertical" margin={{ left: 0, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis type="number" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
            {/* 112px fits "Customer support" / "Product quality" at 10px without clipping. */}
            <YAxis dataKey="name" type="category" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={112} />
            <Tooltip {...TOOLTIP_PROPS} cursor={BAR_CURSOR} />
            <Bar dataKey="value" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </DashboardCard>
  )
}

interface SourceChartProps {
  sources: SourceBreakdown | undefined
}

function SourceChart({ sources }: Readonly<SourceChartProps>) {
  const { t } = useTranslation('dashboard')
  const barData = prepareSourceData(sources)

  return (
    <DashboardCard title={t('feedbackBySource')}>
      <div className="h-[250px] sm:h-[300px] -mx-2 sm:mx-0">
        <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
          <BarChart data={barData} margin={{ left: 0, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="name" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} interval={0} angle={-45} textAnchor="end" height={60} />
            <YAxis tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={35} />
            <Tooltip {...TOOLTIP_PROPS} cursor={BAR_CURSOR} />
            <Bar dataKey="value" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </DashboardCard>
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
}

function UrgentFeedback({ items, aggregateTotal }: Readonly<UrgentFeedbackProps>) {
  const { t } = useTranslation('dashboard')
  const hasItems = items && items.length > 0
  const count = urgentHeadingCount(aggregateTotal, items?.length)

  return (
    <DashboardCard
      icon={<AlertTriangle className="text-warn flex-shrink-0" size={18} aria-hidden="true" />}
      title={<span>{t('metrics.urgentIssues')} ({count})</span>}
    >
      {hasItems ? (
        <div className="space-y-3 max-h-[400px] sm:max-h-[600px] overflow-y-auto">
          {items.slice(0, URGENT_PREVIEW_LIMIT).map((item) => (
            <FeedbackCard key={item.feedback_id} feedback={item} compact />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 text-center py-6 sm:py-8 text-muted text-sm">
          <CheckCircle2 size={20} className="text-ok" aria-hidden="true" />
          {t('noUrgentIssues')}
        </div>
      )}
    </DashboardCard>
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
    queryKey: ['sentiment', dateParams],
    queryFn: () => api.getSentiment(dateParams),
    enabled: isConfigured,
  })

  const { data: categories } = useQuery({
    queryKey: ['categories', dateParams],
    queryFn: () => api.getCategories(dateParams),
    enabled: isConfigured,
  })

  const { data: sources } = useQuery({
    queryKey: ['sources', dateParams],
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

  const sourcesCount = Object.keys(sources?.sources ?? {}).length

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

      <MetricsGrid summary={summary} sourcesCount={sourcesCount} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <TrendChart dailyTotals={summary?.daily_totals} />
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
