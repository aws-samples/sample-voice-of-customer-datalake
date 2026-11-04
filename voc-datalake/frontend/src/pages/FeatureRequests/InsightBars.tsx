/**
 * @fileoverview One Insights breakdown (requests by category, status or sentiment) as a horizontal
 * bar chart in a card, drawn like the Dashboard's (names on the Y axis, cut with an ellipsis and a
 * tooltip; compact counts on the X axis). The rows are also listed as text for screen readers.
 *
 * @module pages/FeatureRequests/InsightBars
 */
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CategoryAxisTick } from '../Dashboard/CategoryAxisTick'
import { barChartHeight, categoryAxisWidth } from '../Dashboard/axisLabel'
import { tooltipFormatter } from '../Dashboard/chartTooltip'
import { AXIS_LINE, AXIS_TICK, BAR_CURSOR, CHART_CONTAINER_PROPS, GRID_STROKE, TOOLTIP_PROPS } from '../Dashboard/chartTheme'
import { useCategoryAxisMax } from '../Dashboard/useCategoryAxisMax'
import { useCompactTick } from '../Dashboard/useCompactTick'
import { formatCount } from '../../utils/numberFormat'

export interface InsightBarRow {
  readonly key: string
  readonly name: string
  readonly value: number
}

export default function InsightBars({ title, rows, fill, testId }: Readonly<{
  title: string; rows: readonly InsightBarRow[]; fill: string; testId: string
}>) {
  const { t, i18n } = useTranslation('featureRequests')
  const tick = useCompactTick()
  const axisWidth = categoryAxisWidth(rows.map((row) => row.name), useCategoryAxisMax())
  return (
    <section className="card p-4 space-y-3 min-w-0" data-testid={testId} aria-label={title}>
      <h3 className="text-sm font-medium text-text-strong">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-muted">{t('insights.noData')}</p> : (
        <>
          <div aria-hidden="true" style={{ height: barChartHeight(rows.length) }}>
            <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
              <BarChart data={[...rows]} layout="vertical" margin={{ left: 0, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                <XAxis type="number" allowDecimals={false} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} tickFormatter={tick} />
                <YAxis dataKey="name" type="category" interval={0} tick={<CategoryAxisTick axisWidth={axisWidth} />}
                  axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={axisWidth} />
                <Tooltip {...TOOLTIP_PROPS} cursor={BAR_CURSOR} formatter={tooltipFormatter(i18n.language)} />
                <Bar dataKey="value" name={t('insights.requests')} fill={fill} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ul className="sr-only">
            {rows.map((row) => <li key={row.key}>{t('insights.rowText', { name: row.name, count: row.value, value: formatCount(row.value, i18n.language) })}</li>)}
          </ul>
        </>
      )}
    </section>
  )
}
