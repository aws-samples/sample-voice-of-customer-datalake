/**
 * @fileoverview The Dashboard's metric tiles, sentiment donut and urgent preview.
 *
 * - Average sentiment reads in words with its share ("Mostly negative", then
 *   "78 % negative · −0.78"); its icon follows the WORDS (a frown for a negative
 *   window), never a trending-up arrow for a negative average.
 * - "Sources with reviews" counts only sources that brought a review in the window.
 * - The donut's legend chips and the urgent list's "See all N urgent" open
 *   Categories filtered the same way.
 *
 * @module pages/Dashboard/DashboardSections
 */
import { Tooltip, ResponsiveContainer, PieChart, Pie } from 'recharts'
import { MessageSquare, AlertTriangle, Users, CheckCircle2, ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { MetricsSummary, SentimentBreakdown, FeedbackItem } from '../../api/types'
import MetricCard from '../../components/MetricCard/MetricCard'
import FeedbackCard from '../../components/FeedbackCard/FeedbackCard'
import { SENTIMENT_TONE_DISPLAY, sentimentShareText, sentimentTone, sentimentWords, signedAverage } from '../../components/SentimentWords/sentimentWords'
import { readPartialWindow } from '../../api/partialWindow'
import { formatPercent } from '../../utils/numberFormat'
import DashboardCard from './DashboardCard'
import { partialHintText } from './dashboardData'
import { CHART_CONTAINER_PROPS, TOOLTIP_PROPS } from './chartTheme'
import { tooltipFormatter } from './chartTooltip'

/**
 * How many urgent items the dashboard previews. The list is a preview, not the
 * full set — the heading reports the true total from /metrics/summary.
 */
export const URGENT_PREVIEW_LIMIT = 5

interface MetricsGridProps {
  readonly summary: MetricsSummary | undefined
  readonly sentiment: SentimentBreakdown | undefined
  readonly activeSources: number
}

function SentimentTile({ summary, sentiment }: Readonly<Omit<MetricsGridProps, 'activeSources'>>) {
  const { t, i18n } = useTranslation('dashboard')
  const average = summary ? summary.avg_sentiment : 0
  const tone = sentimentTone(average)
  const { Icon, color } = SENTIMENT_TONE_DISPLAY[tone]
  const share = sentiment === undefined ? undefined : sentimentShareText(t, average, sentiment.breakdown)
  return (
    <MetricCard
      title={t('metrics.avgSentiment')}
      value={sentimentWords(t, average)}
      detail={share === undefined ? signedAverage(average, i18n.language) : `${share} · ${signedAverage(average, i18n.language)}`}
      icon={<Icon size={24} />}
      color={color}
    />
  )
}

export function MetricsGrid({ summary, sentiment, activeSources }: MetricsGridProps) {
  const { t } = useTranslation(['dashboard', 'common'])
  // The counts are a lower bound when the window was read only in part; the cards say so.
  const { isPartial, scannedThrough } = readPartialWindow(summary)
  const partialHint = partialHintText(isPartial, scannedThrough, t)
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-3 sm:gap-4">
      <MetricCard
        title={t('metrics.totalFeedback')}
        value={summary?.total_feedback ?? 0}
        approximate={isPartial}
        icon={<MessageSquare size={24} />}
        color="accent"
        hint={partialHint}
      />
      <SentimentTile summary={summary} sentiment={sentiment} />
      <MetricCard
        title={t('metrics.urgentIssues')}
        value={summary?.urgent_count ?? 0}
        approximate={isPartial}
        icon={<AlertTriangle size={24} />}
        color="warn"
        hint={partialHint}
      />
      <MetricCard
        title={t('metrics.sourcesWithReviews')}
        value={activeSources}
        icon={<Users size={24} />}
        color="muted"
      />
    </div>
  )
}

// Theme tokens (src/index.css), in SENTIMENT_ORDER.
const SENTIMENT_ORDER = ['positive', 'neutral', 'negative', 'mixed'] as const
const SENTIMENT_FILL: Readonly<Record<(typeof SENTIMENT_ORDER)[number], string>> = {
  positive: 'var(--sentiment-positive)', neutral: 'var(--sentiment-neutral)',
  negative: 'var(--sentiment-negative)', mixed: 'var(--sentiment-mixed)',
}

function prepareSentimentPieData(sentiment: SentimentBreakdown | undefined) {
  if (!sentiment) return []
  return SENTIMENT_ORDER
    // A label absent from the breakdown is 0 and, like a present 0, filtered out below.
    .map((key) => ({ key, value: sentiment.breakdown[key] ?? 0, fill: SENTIMENT_FILL[key] }))
    .filter((d) => d.value > 0)
}

/**
 * Donut plus a chip legend; each chip opens Categories filtered by its sentiment.
 * The legend replaces Recharts' outer slice labels, which clipped on mobile.
 */
export function SentimentChart({ sentiment }: Readonly<{ sentiment: SentimentBreakdown | undefined }>) {
  const { t, i18n } = useTranslation('dashboard')
  const pieData = prepareSentimentPieData(sentiment).map((d) => ({ ...d, name: t(`sentiment.${d.key}`) }))
  const total = pieData.reduce((sum, d) => sum + d.value, 0)
  return (
    <DashboardCard title={t('sentimentDistribution')}>
      <div className="h-[180px] sm:h-[250px]">
        <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
          <PieChart>
            <Pie data={pieData} cx="50%" cy="50%" innerRadius="55%" outerRadius="85%" paddingAngle={2} dataKey="value" nameKey="name" stroke="var(--card)" />
            <Tooltip {...TOOLTIP_PROPS} formatter={tooltipFormatter(i18n.language)} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-3 flex flex-wrap justify-center gap-1.5">
        {pieData.map((d) => (
          <li key={d.key}>
            <Link
              to={`/categories?sentiment=${d.key}`}
              title={t('openInCategories', { name: d.name })}
              className="inline-flex items-center gap-1.5 rounded-full bg-bg-hover px-2.5 py-1 text-xs text-text hover:bg-border focus-ring"
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.fill }} aria-hidden="true" />
              {d.name}
              <span className="font-mono text-muted">{formatPercent(total > 0 ? (d.value / total) * 100 : 0, i18n.language)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </DashboardCard>
  )
}

/**
 * Count for the "Urgent Issues (N)" heading: the larger of the exact aggregate
 * (/metrics/summary) and the rendered preview, so it never understates the total
 * nor claims fewer items than are visibly rendered.
 */
function urgentHeadingCount(aggregateTotal: number | undefined, previewLength: number | undefined): number {
  return Math.max(aggregateTotal ?? 0, previewLength ?? 0)
}

interface UrgentFeedbackProps {
  readonly items: FeedbackItem[] | undefined
  /** Exact urgent total for the window, from /metrics/summary's `urgent_count`. */
  readonly aggregateTotal: number | undefined
}

export function UrgentFeedback({ items, aggregateTotal }: UrgentFeedbackProps) {
  const { t } = useTranslation('dashboard')
  const hasItems = items !== undefined && items.length > 0
  const count = urgentHeadingCount(aggregateTotal, items?.length)
  return (
    <DashboardCard
      icon={<AlertTriangle className="text-warn flex-shrink-0" size={18} aria-hidden="true" />}
      title={<span>{t('metrics.urgentIssues')} ({count})</span>}
    >
      {hasItems ? (
        <>
          <div className="space-y-3 max-h-[400px] sm:max-h-[600px] overflow-y-auto">
            {items.slice(0, URGENT_PREVIEW_LIMIT).map((item) => (
              <FeedbackCard key={item.feedback_id} feedback={item} compact />
            ))}
          </div>
          <Link to="/categories?urgent=1" className="btn btn-ghost btn-sm mt-3 text-accent-text">
            {t('seeAllUrgent', { count })}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 text-center py-6 sm:py-8 text-muted text-sm">
          <CheckCircle2 size={20} className="text-ok" aria-hidden="true" />
          {t('noUrgentIssues')}
        </div>
      )}
    </DashboardCard>
  )
}
