/**
 * @fileoverview A brand's daily review count and average sentiment. Clicking a day's bar
 * opens that day's reviews; the "Read a day's reviews" list below is the same thing for
 * keyboard and screen-reader users (a chart bar is not focusable).
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
import { formatCalendarDay } from '../../utils/dateUtils'
import type { RadarDetail } from '../../api/radarSchema'

type TrendProps = Readonly<{ trend: RadarDetail['trend']; onDay: (day: string) => void }>

function DayList({ trend, onDay }: TrendProps) {
  const { t, i18n } = useTranslation('radar')
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-accent">{t('reviews.readDay')}</summary>
      <ul className="mt-2 flex flex-wrap gap-2">
        {[...trend].reverse().map((point) => (
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

export default function TrendChart({ trend, onDay }: TrendProps) {
  const { t, i18n } = useTranslation('radar')
  const tick = (day: unknown) => (typeof day === 'string' ? formatCalendarDay(day, i18n.language, 'short') : '')
  const countTick = useCompactTick()
  const scoreTick = (value: unknown) => (typeof value === 'number' ? formatDecimal(value, i18n.language, 1) : '')
  const tooltipDay = (day: unknown) => (typeof day === 'string' ? formatCalendarDay(day, i18n.language) : '')
  const data = trend.map((point) => ({
    date: point.date, [t('trend.reviews')]: point.count, [t('trend.sentiment')]: point.avg_sentiment,
  }))
  const openBar = (_entry: unknown, index: number) => {
    const point = trend.at(index)
    if (point !== undefined) onDay(point.date)
  }
  return (
    <section className="card" aria-labelledby="radar-trend">
      <SectionTitle id="radar-trend" icon={Activity}>{t('trend.title')}</SectionTitle>
      {data.length === 0 ? <p className="text-sm text-muted">{t('trend.empty')}</p> : (
        <>
          <div className="h-[220px] sm:h-[260px]" data-testid="radar-trend-chart">
            <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
              <ComposedChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                {/* Dates thin out on a narrow screen instead of overlapping. */}
                <XAxis dataKey="date" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} minTickGap={16} interval="preserveStartEnd" tickFormatter={tick} />
                <YAxis yAxisId="count" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} allowDecimals={false} width={NUMBER_AXIS_WIDTH} tickFormatter={countTick} />
                <YAxis yAxisId="score" orientation="right" domain={[-1, 1]} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} tickFormatter={scoreTick} />
                <Tooltip {...TOOLTIP_PROPS} labelFormatter={tooltipDay} formatter={tooltipFormatter(i18n.language, [t('trend.sentiment')])} />
                <Bar yAxisId="count" dataKey={t('trend.reviews')} fill="var(--chart-3)" radius={[4, 4, 0, 0]}
                  cursor="pointer" onClick={openBar} />
                <Line yAxisId="score" type="monotone" dataKey={t('trend.sentiment')} stroke="var(--chart-1)" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <DayList trend={trend} onDay={onDay} />
        </>
      )}
    </section>
  )
}
