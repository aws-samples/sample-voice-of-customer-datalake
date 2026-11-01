/**
 * @fileoverview A brand's daily review count and average sentiment over the WHOLE window (a day
 * without reviews is a 0 bar and no sentiment point), with labelled axes, a legend and straight
 * lines. Below {@link MIN_TREND_REVIEWS} reviews in the window it says so instead of drawing a trend.
 * Clicking a day's bar opens that day's reviews; the "Read a day's reviews" list below is the same
 * thing for keyboard and screen-reader users (a chart bar is not focusable).
 * @module pages/Radar/TrendChart
 */
import { Activity } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AXIS_LINE, AXIS_TICK, CHART_CONTAINER_PROPS, GRID_STROKE, TOOLTIP_PROPS } from '../Dashboard/chartTheme'
import { NUMBER_AXIS_WIDTH } from '../Dashboard/axisLabel'
import { formatDecimal } from '../../utils/numberFormat'
import { useCompactTick } from '../Dashboard/useCompactTick'
import { tooltipFormatter } from '../Dashboard/chartTooltip'
import SectionTitle from './SectionTitle'
import { fillWindow } from './radarGroups'
import { formatCalendarDay } from '../../utils/dateUtils'
import type { RadarDetail } from '../../api/radarSchema'

/** Under this many reviews in the window, a trend line says nothing: a sentence replaces the chart. */
const MIN_TREND_REVIEWS = 10

type Trend = RadarDetail['trend']
type TrendProps = Readonly<{ trend: Trend; days: number; onDay: (day: string) => void; onReadAll: () => void }>

const COUNT_COLOUR = 'var(--chart-3)'
const SENTIMENT_COLOUR = 'var(--chart-1)'

function DayList({ trend, onDay }: Readonly<{ trend: Trend; onDay: (day: string) => void }>) {
  const { t, i18n } = useTranslation('radar')
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-accent-text">{t('reviews.readDay')}</summary>
      <ul className="mt-2 flex flex-wrap gap-2">
        {[...trend].filter((point) => point.count > 0).reverse().map((point) => (
          <li key={point.date}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onDay(point.date)}>
              {t('reviews.dayEntry', { day: formatCalendarDay(point.date, i18n.language), count: point.count })}
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** The two series, by the same colours as the chart (a swatch beside each name). */
function Legend() {
  const { t } = useTranslation('radar')
  const entries = [
    { label: t('trend.reviews'), colour: COUNT_COLOUR, shape: 'w-2.5 h-2.5 rounded-sm' },
    { label: t('trend.sentiment'), colour: SENTIMENT_COLOUR, shape: 'w-3 h-0.5' },
  ]
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text mb-2" aria-label={t('trend.legend')}>
      {entries.map(({ label, colour, shape }) => (
        <li key={label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block ${shape}`} style={{ backgroundColor: colour }} />{label}
        </li>
      ))}
    </ul>
  )
}

const axisTitle = (value: string, side: 'left' | 'right') => ({
  value, angle: side === 'left' ? -90 : 90, position: side === 'left' ? 'insideLeft' : 'insideRight',
  style: { fill: 'var(--text)', fontSize: 12, textAnchor: 'middle' },
} as const)

function Chart({ trend, days, onDay }: Readonly<{ trend: Trend; days: number; onDay: (day: string) => void }>) {
  const { t, i18n } = useTranslation('radar')
  const tick = (day: unknown) => (typeof day === 'string' ? formatCalendarDay(day, i18n.language, 'short') : '')
  const countTick = useCompactTick()
  const scoreTick = (value: unknown) => (typeof value === 'number' ? formatDecimal(value, i18n.language, 1) : '')
  const tooltipDay = (day: unknown) => (typeof day === 'string' ? formatCalendarDay(day, i18n.language) : '')
  const filled = fillWindow(trend, days)
  const data = filled.map((point) => ({
    date: point.date, [t('trend.reviews')]: point.count, [t('trend.sentiment')]: point.avg_sentiment,
  }))
  const openBar = (_entry: unknown, index: number) => {
    const point = filled.at(index)
    if (point !== undefined && point.count > 0) onDay(point.date)
  }
  return (
    <div className="h-[240px] sm:h-[280px]" data-testid="radar-trend-chart">
      <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
        <ComposedChart data={data} margin={{ left: 8, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          {/* Dates thin out on a narrow screen instead of overlapping. */}
          <XAxis dataKey="date" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} minTickGap={16} interval="preserveStartEnd" tickFormatter={tick} />
          <YAxis yAxisId="count" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} allowDecimals={false} width={NUMBER_AXIS_WIDTH}
            tickFormatter={countTick} label={axisTitle(t('trend.reviews'), 'left')} />
          <YAxis yAxisId="score" orientation="right" domain={[-1, 1]} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE}
            tickFormatter={scoreTick} label={axisTitle(t('trend.sentiment'), 'right')} />
          <Tooltip {...TOOLTIP_PROPS} labelFormatter={tooltipDay} formatter={tooltipFormatter(i18n.language, [t('trend.sentiment')])} />
          <Bar yAxisId="count" dataKey={t('trend.reviews')} fill={COUNT_COLOUR} radius={[4, 4, 0, 0]} cursor="pointer" onClick={openBar} />
          {/* Straight segments between the days that have reviews: a smoothed curve overshoots the -1..1 scale. */}
          <Line yAxisId="score" type="linear" dataKey={t('trend.sentiment')} stroke={SENTIMENT_COLOUR} connectNulls
            dot={{ r: 2, fill: SENTIMENT_COLOUR }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** "Only 6 reviews in this window: too few for a trend", with a way to read them. */
function TooFew({ total, onReadAll }: Readonly<{ total: number; onReadAll: () => void }>) {
  const { t } = useTranslation('radar')
  return (
    <p className="text-sm text-text flex flex-wrap items-baseline gap-x-2 gap-y-1" data-testid="radar-trend-too-few">
      <span>{t('trend.tooFew', { count: total })}</span>
      <button type="button" className="link text-sm" onClick={() => onReadAll()}>{t('trend.readThem', { count: total })}</button>
    </p>
  )
}

export default function TrendChart({ trend, days, onDay, onReadAll }: TrendProps) {
  const { t } = useTranslation('radar')
  const total = trend.reduce((sum, point) => sum + point.count, 0)
  return (
    <section className="card min-w-0" aria-labelledby="radar-trend">
      <SectionTitle id="radar-trend" icon={Activity}>{t('trend.title')}</SectionTitle>
      {total === 0 ? <p className="text-sm text-muted">{t('trend.empty')}</p> : null}
      {total > 0 && total < MIN_TREND_REVIEWS ? <TooFew total={total} onReadAll={onReadAll} /> : null}
      {total >= MIN_TREND_REVIEWS ? (
        <>
          <Legend />
          <Chart trend={trend} days={days} onDay={onDay} />
          <DayList trend={trend} onDay={onDay} />
        </>
      ) : null}
    </section>
  )
}
