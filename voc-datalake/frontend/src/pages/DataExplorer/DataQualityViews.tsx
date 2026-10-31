/**
 * @fileoverview The Data quality section's chart (a stacked bar per source) and table (counts and the
 * not-rated share per source). Presentational: the section reads the data (DataQualitySection.tsx).
 * @module pages/DataExplorer/DataQualityViews
 */
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AXIS_LINE, AXIS_TICK, CHART_CONTAINER_PROPS, GRID_STROKE, TOOLTIP_PROPS } from '../Dashboard/chartTheme'
import { formatCount, formatPercent } from '../../utils/numberFormat'
import { QUALITY_BANDS, shareOf } from '../../api/dataQualitySchema'
import type { QualityBand, QualityCounts, SourceQuality } from '../../api/dataQualitySchema'

/** Sources drawn in the chart (busiest first); the table lists every one. */
export const CHART_MAX_SOURCES = 8
const ROW_HEIGHT_PX = 36
const CHART_PADDING_PX = 56
const SOURCE_AXIS_WIDTH = 140

// Four clearly different hues in both themes (green, blue, orange, grey): two purples read as one.
const BAND_COLORS: Readonly<Record<QualityBand, string>> = {
  high: 'var(--chart-7)',
  medium: 'var(--chart-2)',
  low: 'var(--chart-4)',
  unrated: 'var(--chart-6)',
}

/** Static keys, so the i18n audit sees every label the section uses. */
const BAND_LABEL_KEYS = {
  high: 'dataQuality.bands.high',
  medium: 'dataQuality.bands.medium',
  low: 'dataQuality.bands.low',
  unrated: 'dataQuality.bands.unrated',
} as const satisfies Record<QualityBand, string>

interface ViewProps {
  readonly sources: readonly SourceQuality[]
  readonly sourceName: (source: string) => string
}

export function QualityChart({ sources, sourceName }: ViewProps) {
  const { t, i18n } = useTranslation('dataExplorer')
  const shown = sources.slice(0, CHART_MAX_SOURCES)
  // Keyed by the stable band id: the translated label is only the series name, so two bands that
  // translate alike never collapse into one segment and a language switch does not rebuild the rows.
  const data = shown.map((row) => ({
    name: sourceName(row.source),
    high: row.high, medium: row.medium, low: row.low, unrated: row.unrated,
  }))
  const height = shown.length * ROW_HEIGHT_PX + CHART_PADDING_PX
  return (
    <div style={{ height }} data-testid="data-quality-chart" aria-hidden="true">
      <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE}
            tickFormatter={(value: unknown) => (typeof value === 'number' ? formatCount(value, i18n.language) : '')} />
          <YAxis type="category" dataKey="name" width={SOURCE_AXIS_WIDTH} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          <Tooltip {...TOOLTIP_PROPS} />
          {/* In band order (best first), not Recharts' default alphabetical order. */}
          <Legend itemSorter={null} />
          {QUALITY_BANDS.map((band) => (
            <Bar key={band} dataKey={band} name={t(BAND_LABEL_KEYS[band])} stackId="quality" fill={BAND_COLORS[band]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** A count and its share of `total`, right-aligned. */
function CountCell({ count, total }: Readonly<{ count: number; total: number }>) {
  const { i18n } = useTranslation()
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      {formatCount(count, i18n.language)}
      <span className="ml-1 text-xs text-muted">({formatPercent(shareOf(count, total), i18n.language)})</span>
    </td>
  )
}

/** One table row: a label, each count with its share of `total`, then the total (the band and profile tables). */
export function CountRow({ label, counts, total, strong = false }: Readonly<{
  label: string; counts: ReadonlyArray<readonly [string, number]>; total: number; strong?: boolean
}>) {
  const { i18n } = useTranslation()
  return (
    <tr className={clsx('border-t border-border', strong && 'font-semibold')}>
      <th scope="row" className="px-3 py-2 text-left font-medium text-text-strong">{label}</th>
      {counts.map(([key, count]) => <CountCell key={key} count={count} total={total} />)}
      <td className="px-3 py-2 text-right tabular-nums">{formatCount(total, i18n.language)}</td>
    </tr>
  )
}

function QualityRow({ label, counts, strong = false }: Readonly<{ label: string; counts: QualityCounts; strong?: boolean }>) {
  return (
    <CountRow label={label} counts={QUALITY_BANDS.map((band): [string, number] => [band, counts[band]])}
      total={counts.total} strong={strong} />
  )
}

export function QualityTable({ sources, sourceName, overall }: ViewProps & { readonly overall: QualityCounts }) {
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{t('dataQuality.tableCaption')}</caption>
        <thead>
          <tr className="text-muted">
            <th scope="col" className="px-3 py-2 text-left font-medium">{t('dataQuality.columns.source')}</th>
            {QUALITY_BANDS.map((band) => (
              <th key={band} scope="col" className="px-3 py-2 text-right font-medium">{t(BAND_LABEL_KEYS[band])}</th>
            ))}
            <th scope="col" className="px-3 py-2 text-right font-medium">{t('dataQuality.columns.total')}</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((row) => <QualityRow key={row.source} label={sourceName(row.source)} counts={row} />)}
          {sources.length > 1 && <QualityRow label={t('dataQuality.allSources')} counts={overall} strong />}
        </tbody>
      </table>
    </div>
  )
}
