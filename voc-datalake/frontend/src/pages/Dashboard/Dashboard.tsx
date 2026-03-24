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
import { MessageSquare, TrendingUp, AlertTriangle, Users, Zap, FileDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api, getDaysFromRange } from '../../api/client'
import type { MetricsSummary, SentimentBreakdown, CategoryBreakdown, SourceBreakdown, FeedbackItem } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import MetricCard from '../../components/MetricCard'
import FeedbackCard from '../../components/FeedbackCard'
import SocialFeed from '../../components/SocialFeed'
import { generateDashboardPDF } from './dashboardPdfGenerator'

const COLORS = ['#22c55e', '#6b7280', '#ef4444', '#eab308']

function NotConfiguredState() {
  const { t } = useTranslation('dashboard')
  const { t: tc } = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-center max-w-md">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">{t('welcome')}</h2>
        <p className="text-gray-600 mb-6">
          {t('welcomeDescription')}
        </p>
        <a href="/settings" className="btn btn-primary">
          {tc('goToSettings')}
        </a>
      </div>
    </div>
  )
}

function LoadingState() {
  const { t } = useTranslation()
  return <div className="flex items-center justify-center h-full">{t('loading')}</div>
}

interface MetricsGridProps {
  summary: MetricsSummary | undefined
  sourcesCount: number
}

function MetricsGrid({ summary, sourcesCount }: Readonly<MetricsGridProps>) {
  const { t } = useTranslation()
  const avgSentiment = summary ? Number(summary.avg_sentiment) : 0
  const sentimentTrend = avgSentiment > 0 ? 'up' : 'down'
  const sentimentColor = avgSentiment > 0 ? 'green' : 'red'

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      <MetricCard
        title={t('metrics.totalFeedback')}
        value={summary?.total_feedback.toLocaleString() || 0}
        icon={<MessageSquare size={24} />}
        color="blue"
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
        value={summary?.urgent_count || 0}
        icon={<AlertTriangle size={24} />}
        color="orange"
      />
      <MetricCard
        title={t('metrics.sourcesActive')}
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
  const { t } = useTranslation('dashboard')
  const sortedData = [...(dailyTotals || [])].sort((a, b) => a.date.localeCompare(b.date))

  return (
    <div className="card !p-4 sm:!p-6">
      <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">{t('feedbackVolumeTrend')}</h3>
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

function prepareSentimentPieData(sentiment: SentimentBreakdown | undefined, t: (key: string) => string) {
  if (!sentiment) return []
  return [
    { name: t('sentiment.positive'), value: sentiment.breakdown.positive || 0, fill: COLORS[0] },
    { name: t('sentiment.neutral'), value: sentiment.breakdown.neutral || 0, fill: COLORS[1] },
    { name: t('sentiment.negative'), value: sentiment.breakdown.negative || 0, fill: COLORS[2] },
    { name: t('sentiment.mixed'), value: sentiment.breakdown.mixed || 0, fill: COLORS[3] },
  ].filter(d => d.value > 0)
}

interface SentimentChartProps {
  sentiment: SentimentBreakdown | undefined
}

function SentimentChart({ sentiment }: Readonly<SentimentChartProps>) {
  const { t } = useTranslation()
  const { t: td } = useTranslation('dashboard')
  const pieData = prepareSentimentPieData(sentiment, t)

  return (
    <div className="card !p-4 sm:!p-6">
      <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">{td('sentimentDistribution')}</h3>
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
            />
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
  const { t } = useTranslation('dashboard')
  const barData = prepareCategoryData(categories)

  return (
    <div className="card !p-4 sm:!p-6">
      <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">{t('topIssueCategories')}</h3>
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
  const { t } = useTranslation('dashboard')
  const barData = prepareSourceData(sources)

  return (
    <div className="card !p-4 sm:!p-6">
      <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">{t('feedbackBySource')}</h3>
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
  count: number
}

function UrgentFeedback({ items, count }: Readonly<UrgentFeedbackProps>) {
  const { t } = useTranslation('dashboard')
  const hasItems = items && items.length > 0

  return (
    <div className="card !p-4 sm:!p-6">
      <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4 flex items-center gap-2">
        <AlertTriangle className="text-orange-500 flex-shrink-0" size={20} />
        <span>{t('urgentIssues', { count })}</span>
      </h3>
      {hasItems ? (
        <div className="space-y-3 max-h-[400px] sm:max-h-[600px] overflow-y-auto">
          {items.slice(0, 6).map((item) => (
            <FeedbackCard key={item.feedback_id} feedback={item} compact />
          ))}
        </div>
      ) : (
        <div className="text-center py-6 sm:py-8 text-gray-500">
          {t('noUrgentIssues')}
        </div>
      )}
    </div>
  )
}

function buildSentimentEntries(sentiment: SentimentBreakdown | undefined) {
  if (!sentiment) return []
  return Object.entries(sentiment.breakdown).filter(([, v]) => v > 0).map(([name, value]) => ({ name, value }))
}

function buildCategoryEntries(categories: CategoryBreakdown | undefined) {
  if (!categories) return []
  return Object.entries(categories.categories).sort(([, a], [, b]) => b - a).slice(0, 10).map(([name, value]) => ({ name, value }))
}

function buildSourceEntries(sources: SourceBreakdown | undefined) {
  if (!sources) return []
  return Object.entries(sources.sources).map(([name, value]) => ({ name: name.replace('_', ' '), value }))
}

function buildPDFExportData(
  summary: MetricsSummary | undefined,
  sentiment: SentimentBreakdown | undefined,
  categories: CategoryBreakdown | undefined,
  sources: SourceBreakdown | undefined,
  urgentFeedback: { items?: FeedbackItem[]; count?: number } | undefined,
  timeRange: string,
  sourcesCount: number,
) {
  return {
    timeRange,
    totalFeedback: summary?.total_feedback ?? 0,
    avgSentiment: summary ? Number(summary.avg_sentiment) : 0,
    urgentCount: summary?.urgent_count ?? 0,
    sourcesCount,
    dailyTotals: summary?.daily_totals ?? [],
    sentimentBreakdown: buildSentimentEntries(sentiment),
    categoryBreakdown: buildCategoryEntries(categories),
    sourceBreakdown: buildSourceEntries(sources),
    urgentItems: urgentFeedback?.items ?? [],
  }
}

export default function Dashboard() {
  const { t } = useTranslation('dashboard')
  const { timeRange, customDateRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange, customDateRange)
  const isConfigured = !!config.apiEndpoint

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['summary', days],
    queryFn: () => api.getSummary(days),
    enabled: isConfigured,
  })

  const { data: sentiment } = useQuery({
    queryKey: ['sentiment', days],
    queryFn: () => api.getSentiment(days),
    enabled: isConfigured,
  })

  const { data: categories } = useQuery({
    queryKey: ['categories', days],
    queryFn: () => api.getCategories(days),
    enabled: isConfigured,
  })

  const { data: sources } = useQuery({
    queryKey: ['sources', days],
    queryFn: () => api.getSources(days),
    enabled: isConfigured,
  })

  const { data: urgentFeedback } = useQuery({
    queryKey: ['urgent', days],
    queryFn: () => api.getUrgentFeedback({ days, limit: 5 }),
    enabled: isConfigured,
  })

  if (!isConfigured) {
    return <NotConfiguredState />
  }

  if (summaryLoading) {
    return <LoadingState />
  }

  const sourcesCount = Object.keys(sources?.sources || {}).length

  const exportPDF = () => {
    try {
      generateDashboardPDF(buildPDFExportData(summary, sentiment, categories, sources, urgentFeedback, timeRange, sourcesCount))
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('PDF export failed:', error)
      }
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex justify-end">
        <button
          onClick={exportPDF}
          className="btn btn-secondary text-xs sm:text-sm px-3 py-1.5 active:scale-95 flex items-center gap-1.5"
          title="Export as PDF"
        >
          <FileDown size={14} />
          PDF
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <div className="card !p-4 sm:!p-6">
          <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4 flex items-center gap-2">
            <Zap className="text-blue-500 flex-shrink-0" size={20} />
            {t('liveSocialFeed')}
          </h3>
          <SocialFeed limit={8} showFilters={true} />
        </div>
        <UrgentFeedback items={urgentFeedback?.items} count={urgentFeedback?.count || 0} />
      </div>
    </div>
  )
}
