/**
 * @fileoverview The Dashboard's volume & sentiment trend, top-categories and by-source charts.
 *
 * The trend draws what its title says: one bar per day (reviews, every missing
 * day filled with 0, so nothing is bridged or dipped) and the day's average
 * sentiment as a line on its own −1 … +1 axis. Its tooltip says "Reviews" and
 * "Average sentiment" (with the words), never a raw data key.
 *
 * Axes never clip at any width (390 px phone to 1440 px desktop):
 * - number axes use compact notation (`10K`, `10 Tsd.`) and are sized from their
 *   rendered ticks (`width="auto"`, NUMBER_AXIS_WIDTH);
 * - category names sit on the Y axis of a horizontal bar chart, cut with an
 *   ellipsis by CategoryAxisTick with the full name as its tooltip.
 *
 * A category or source bar opens Categories filtered by it; the same links are
 * listed for keyboard users (visible when focused).
 *
 * @module pages/Dashboard/DashboardCharts
 */
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { CategoryBreakdown, MetricsSummary, SourceBreakdown } from '../../api/types'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { formatCalendarDay } from '../../utils/dateUtils'
import { topCategoryEntries } from '../../utils/categoryOrder'
import { sentimentWords, signedAverage } from '../../components/SentimentWords/sentimentWords'
import DashboardCard from './DashboardCard'
import { CategoryAxisTick } from './CategoryAxisTick'
import { NUMBER_AXIS_WIDTH, barChartHeight, categoryAxisWidth, sentimentTickFormatter } from './axisLabel'
import { useCategoryAxisMax } from './useCategoryAxisMax'
import { sourceChartRows, trendSeries } from './dashboardData'
import type { ChartRow } from './dashboardData'
import { useCompactTick } from './useCompactTick'
import { AXIS_LINE, AXIS_TICK, BAR_CURSOR, CHART_CONTAINER_PROPS, GRID_STROKE, TOOLTIP_PROPS } from './chartTheme'

const SENTIMENT_DOMAIN: [number, number] = [-1, 1]

interface TrendChartProps {
  readonly summary: Pick<MetricsSummary, 'daily_totals' | 'daily_sentiment'> | undefined
}

export function TrendChart({ summary }: TrendChartProps) {
  const { t, i18n } = useTranslation('dashboard')
  const tick = useCompactTick()
  const series = trendSeries(summary)
  // In the UI language, not the browser's: "Oct 2" / "2. Okt." on the axis,
  // "Oct 2, 2026" in the tooltip, "−0.5" / "−0,5" on the sentiment axis.
  const dayTick = (day: unknown) => formatCalendarDay(String(day), i18n.language, 'short')
  const dayLabel = (day: unknown) => formatCalendarDay(String(day), i18n.language)
  const sentimentTick = sentimentTickFormatter(i18n.language)
  const reviewsName = t('trend.reviews')
  const sentimentName = t('trend.averageSentiment')
  const formatValue = (value: unknown, name: unknown): [string, string] => {
    if (name === sentimentName && typeof value === 'number') return [`${sentimentWords(t, value)} (${signedAverage(value, i18n.language)})`, sentimentName]
    return [String(value), String(name)]
  }

  return (
    <DashboardCard title={t('feedbackVolumeTrend')}>
      <div className="h-[200px] sm:h-[300px] -mx-2 sm:mx-0">
        <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
          <ComposedChart data={series} margin={{ left: 0, right: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="date" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} interval="preserveStartEnd"
              tickFormatter={dayTick} />
            <YAxis yAxisId="reviews" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={NUMBER_AXIS_WIDTH} tickFormatter={tick} allowDecimals={false} />
            <YAxis yAxisId="sentiment" orientation="right" domain={SENTIMENT_DOMAIN} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={36} tickFormatter={sentimentTick} />
            <Tooltip {...TOOLTIP_PROPS} cursor={BAR_CURSOR} formatter={formatValue}
              labelFormatter={dayLabel} />
            <Bar yAxisId="reviews" dataKey="reviews" name={reviewsName} fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
            <Line yAxisId="sentiment" dataKey="sentiment" name={sentimentName} type="monotone" stroke="var(--chart-3)" strokeWidth={2} dot={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-xs text-muted">{t('trend.legend')}</p>
    </DashboardCard>
  )
}

/** A horizontal bar chart of labelled rows: names on the Y axis (ellipsis + tooltip), compact counts on the X axis. */
function HorizontalBars({ rows, fill, onSelect }: Readonly<{ rows: readonly ChartRow[]; fill: string; onSelect: (row: ChartRow) => void }>) {
  const tick = useCompactTick()
  const maxAxisWidth = useCategoryAxisMax()
  const axisWidth = categoryAxisWidth(rows.map((row) => row.name), maxAxisWidth)
  const select = (_: unknown, index: number) => {
    const row = rows.at(index)
    if (row !== undefined && row.id !== null) onSelect(row)
  }
  return (
    <div className="-mx-2 sm:mx-0" style={{ height: barChartHeight(rows.length) }}>
      <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
        <BarChart data={[...rows]} layout="vertical" margin={{ left: 0, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          <XAxis type="number" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} tickFormatter={tick} />
          <YAxis
            dataKey="name"
            type="category"
            interval={0}
            tick={<CategoryAxisTick axisWidth={axisWidth} />}
            axisLine={AXIS_LINE}
            tickLine={AXIS_LINE}
            width={axisWidth}
          />
          <Tooltip {...TOOLTIP_PROPS} cursor={BAR_CURSOR} />
          <Bar dataKey="value" fill={fill} radius={[0, 4, 4, 0]} onClick={select} className="cursor-pointer" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function prepareCategoryData(categories: CategoryBreakdown | undefined, label: (id: string) => string): ChartRow[] {
  if (!categories) return []
  // The eight largest, "Other" (reviews outside the configured categories) last.
  return topCategoryEntries(Object.entries(categories.categories), 8)
    .map(([id, value]) => ({ id, name: label(id), value }))
}

type FilterParam = 'category' | 'source'

/** The Categories view a bar opens: filtered by that bar's category or source. */
function categoriesHref(param: FilterParam, id: string): string {
  return `/categories?${new URLSearchParams({ [param]: id }).toString()}`
}

/**
 * A card of bars that open Categories filtered by their row. The same targets are
 * listed as links for keyboard users (visually hidden until one is focused).
 */
function LinkedBars({ title, rows, fill, param }: Readonly<{ title: string; rows: readonly ChartRow[]; fill: string; param: FilterParam }>) {
  const { t } = useTranslation('dashboard')
  const navigate = useNavigate()
  const targets = rows.filter((row): row is ChartRow & { id: string } => row.id !== null)
  return (
    <DashboardCard title={title}>
      <HorizontalBars rows={rows} fill={fill} onSelect={(row) => { if (row.id !== null) void navigate(categoriesHref(param, row.id)) }} />
      <ul className="sr-only focus-within:not-sr-only focus-within:mt-2 flex flex-wrap gap-2 text-xs">
        {targets.map((row) => (
          <li key={row.id}><Link to={categoriesHref(param, row.id)} className="link">{t('openInCategories', { name: row.name })}</Link></li>
        ))}
      </ul>
    </DashboardCard>
  )
}

export function CategoryChart({ categories }: Readonly<{ categories: CategoryBreakdown | undefined }>) {
  const { t } = useTranslation('dashboard')
  const rows = prepareCategoryData(categories, useDisplayLabels().category)
  return <LinkedBars title={t('topIssueCategories')} rows={rows} fill="var(--chart-1)" param="category" />
}

export function SourceChart({ sources }: Readonly<{ sources: SourceBreakdown | undefined }>) {
  const { t } = useTranslation('dashboard')
  const rows = sourceChartRows(sources, useDisplayLabels().source, (n) => t('otherSources', { n }))
  return <LinkedBars title={t('feedbackBySource')} rows={rows} fill="var(--chart-2)" param="source" />
}
