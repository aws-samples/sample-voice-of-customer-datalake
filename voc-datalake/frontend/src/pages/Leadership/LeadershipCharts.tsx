/**
 * @fileoverview The leadership view's two charts (dataviz skill: the form follows the job; color comes last).
 *
 * - Projects started, per period: magnitude over time, one series, so columns in one hue (`--chart-2`), no legend
 *   (the title names it), a per-column tooltip.
 * - Artifacts by way of working: per artifact type, the part made with AI (`--chart-2`) and by hand (`--chart-4`),
 *   a stacked horizontal bar: two series, so a legend, and a tooltip with both. The pair was run through the
 *   skill's validator on the light and the dark chart surfaces (`--card`, #ffffff and #211d25): every check passes.
 *
 * Marks: bars at most 24 px thick with 4 px rounded data ends, square at the baseline; a 2 px surface gap between
 * stacked segments (their stroke in `--card`); recessive grid and axes (chartTheme.ts). Both tables of figures are
 * in the period table below the charts (the table view).
 * @module pages/Leadership/LeadershipCharts
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ARTIFACT_TYPES } from '../../api/adoptionApi'
import type { AdoptionPeriod } from '../../api/adoptionApi'
import { AXIS_LINE, AXIS_TICK, BAR_CURSOR, CHART_CONTAINER_PROPS, GRID_STROKE, TOOLTIP_PROPS } from '../Dashboard/chartTheme'
import { tooltipFormatter } from '../Dashboard/chartTooltip'
import { periodLabel } from './leadershipRange'

const SERIES_AI = 'var(--chart-2)'
const SERIES_HAND = 'var(--chart-4)'
const SURFACE = 'var(--card)'
const BAR_MAX = 24

export function ChartCard({ title, subtitle, children }: Readonly<{ title: string; subtitle?: string; children: ReactNode }>) {
  return (
    <section className="card space-y-3" aria-label={title}>
      <div>
        <h2 className="text-base font-semibold text-text-strong">{title}</h2>
        {subtitle === undefined ? null : <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {children}
    </section>
  )
}

export function ProjectsChart({ periods }: Readonly<{ periods: readonly AdoptionPeriod[] }>) {
  const { t, i18n } = useTranslation('leadership')
  const quarter = (q: string, year: string) => t('periods.quarter', { quarter: q, year })
  const series = t('charts.projects.series')
  const data = periods.map((period) => ({ label: periodLabel(period.period, i18n.language, quarter),
    [series]: period.projects_started }))
  return (
    <ChartCard title={t('charts.projects.title')} subtitle={t('charts.projects.subtitle')}>
      <div className="h-56">
        <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
            <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} />
            <Tooltip {...TOOLTIP_PROPS} cursor={BAR_CURSOR} formatter={tooltipFormatter(i18n.language)} />
            <Bar dataKey={series} fill={SERIES_AI} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

function Swatch({ color, label }: Readonly<{ color: string; label: string }>) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-text">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  )
}

export function WaysOfWorkingChart({ totals }: Readonly<{ totals: AdoptionPeriod }>) {
  const { t, i18n } = useTranslation('leadership')
  const withAi = t('charts.ways.ai')
  const byHand = t('charts.ways.human')
  const data = ARTIFACT_TYPES.map((type) => ({ label: t(`artifacts.${type}`), [withAi]: totals.artifacts[type].ai,
    [byHand]: totals.artifacts[type].human }))
  return (
    <ChartCard title={t('charts.ways.title')} subtitle={t('charts.ways.subtitle')}>
      <div className="flex flex-wrap gap-4" aria-hidden="true">
        <Swatch color={SERIES_AI} label={withAi} />
        <Swatch color={SERIES_HAND} label={byHand} />
      </div>
      <div className="h-64">
        <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
            <XAxis type="number" allowDecimals={false} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
            <YAxis type="category" dataKey="label" width={96} tick={AXIS_TICK} axisLine={false} tickLine={false} />
            <Tooltip {...TOOLTIP_PROPS} cursor={BAR_CURSOR} formatter={tooltipFormatter(i18n.language)} />
            <Bar dataKey={withAi} stackId="made" fill={SERIES_AI} stroke={SURFACE} strokeWidth={2} maxBarSize={BAR_MAX} />
            <Bar dataKey={byHand} stackId="made" fill={SERIES_HAND} stroke={SURFACE} strokeWidth={2}
              radius={[0, 4, 4, 0]} maxBarSize={BAR_MAX} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}
