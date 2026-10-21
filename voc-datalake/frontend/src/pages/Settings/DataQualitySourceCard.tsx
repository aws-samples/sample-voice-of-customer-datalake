/**
 * @fileoverview One source's profile on the Settings → Data Quality tab: small
 * distribution charts (rating, sentiment, each enrichment field, text length) and,
 * per enrichment field, the buttons that start a calculate-missing or
 * recalculate-all job for that source.
 *
 * Field and value labels resolve from `dataQuality.fields.<name>` /
 * `dataQuality.values.<value>` with the raw name as the default, so a field added
 * to the backend registry renders (and can be enriched) without a code change.
 *
 * @module pages/Settings/DataQualitySourceCard
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import ConfirmModal from '../../components/ConfirmModal'
import { OVERFLOW_SOURCE, UNSCORED_BUCKET } from '../../api/dataQualityApi'
import type {
  DataQualityField,
  DataQualityJob,
  DataQualitySourceStats,
  EnrichMode,
  StartDataQualityJobBody,
} from '../../api/dataQualityApi'
import {
  LENGTH_BUCKETS,
  RATING_BUCKETS,
  SENTIMENT_BUCKETS,
  isEnrichRunning,
  orderedCounts,
  percentOf,
} from './dataQualityUtils'
import type { CountDatum } from './dataQualityUtils'

/** Bar fill per chart (Tailwind amber/blue/emerald/violet 500). */
const CHART_COLORS = {
  rating: '#f59e0b',
  sentiment: '#3b82f6',
  enrichment: '#10b981',
  length: '#8b5cf6',
} as const

interface ChartDatum extends CountDatum {
  readonly label: string
}

const withLabels = (data: CountDatum[], label: (key: string) => string): ChartDatum[] =>
  data.map((datum) => ({ ...datum, label: label(datum.key) }))

interface DataQualitySourceCardProps {
  readonly stats: DataQualitySourceStats
  readonly fields: readonly DataQualityField[]
  readonly jobs: readonly DataQualityJob[]
  readonly isStarting: boolean
  readonly onStart: (body: StartDataQualityJobBody) => void
}

export default function DataQualitySourceCard({
  stats, fields, jobs, isStarting, onStart,
}: DataQualitySourceCardProps) {
  const { t } = useTranslation('settings')
  const ratingData = withLabels(orderedCounts(stats.ratings, RATING_BUCKETS), (key) =>
    key === 'none' ? t('dataQuality.noRating') : key)
  const sentimentData = withLabels(orderedCounts(stats.sentiments, SENTIMENT_BUCKETS), (key) =>
    t(`dataQuality.sentiments.${key}`, { defaultValue: key }))
  const lengthData = withLabels(orderedCounts(stats.lengths, LENGTH_BUCKETS), (key) => key)

  return (
    <section className="card" aria-label={stats.source}>
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h3 className="font-semibold text-gray-900 truncate" title={stats.source}>{stats.source}</h3>
        <span className="text-xs text-gray-500 shrink-0">{t('dataQuality.rows', { count: stats.count })}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <CountsChart title={t('dataQuality.charts.rating')} data={ratingData} color={CHART_COLORS.rating} />
        <CountsChart title={t('dataQuality.charts.sentiment')} data={sentimentData} color={CHART_COLORS.sentiment} />
        {fields.map((field) => (
          <EnrichmentFieldPanel
            key={field.name}
            field={field}
            stats={stats}
            isRunning={isEnrichRunning(jobs, stats.source, field.name)}
            isStarting={isStarting}
            onStart={onStart}
          />
        ))}
        <CountsChart title={t('dataQuality.charts.length')} data={lengthData} color={CHART_COLORS.length} />
      </div>
    </section>
  )
}

interface CountsChartProps {
  readonly title: string
  readonly subtitle?: string
  readonly data: ChartDatum[]
  readonly color: string
  readonly children?: ReactNode
}

function CountsChart({ title, subtitle, data, color, children }: CountsChartProps) {
  // The bars are visual only; the same numbers are given to assistive tech as text.
  const values = data.map((d) => `${d.label} ${d.value.toLocaleString()}`).join(', ')
  const summary = `${title}: ${values}`
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h4 className="text-sm font-medium text-gray-700">{title}</h4>
        {subtitle && <span className="text-xs text-gray-500">{subtitle}</span>}
      </div>
      <div className="h-[120px]" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} />
            <YAxis tick={{ fontSize: 10 }} width={35} allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="value" name={title} fill={color} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {children}
    </div>
  )
}

interface EnrichmentFieldPanelProps {
  readonly field: DataQualityField
  readonly stats: DataQualitySourceStats
  readonly isRunning: boolean
  readonly isStarting: boolean
  readonly onStart: (body: StartDataQualityJobBody) => void
}

function EnrichmentFieldPanel({ field, stats, isRunning, isStarting, onStart }: EnrichmentFieldPanelProps) {
  const { t } = useTranslation('settings')
  const counts = stats.enrichment[field.name] ?? {}
  const unscored = counts[UNSCORED_BUCKET] ?? 0
  const fieldLabel = t(`dataQuality.fields.${field.name}`, { defaultValue: field.name })
  const data = withLabels(orderedCounts(counts, [...field.values, UNSCORED_BUCKET]), (key) =>
    t(`dataQuality.values.${key}`, { defaultValue: key }))
  const start = (mode: EnrichMode) =>
    onStart({ kind: 'enrich', source: stats.source, field: field.name, mode })

  return (
    <CountsChart
      title={fieldLabel}
      subtitle={t('dataQuality.unscoredShare', { unscored, percent: percentOf(unscored, stats.count) })}
      data={data}
      color={CHART_COLORS.enrichment}
    >
      {/* The overflow bucket folds many partitions together — there is no single
          source to enrich, so it is profile-only. */}
      {stats.source !== OVERFLOW_SOURCE && (
        <EnrichActions
          fieldLabel={fieldLabel}
          source={stats.source}
          rowCount={stats.count}
          unscored={unscored}
          disabled={isRunning || isStarting}
          onStart={start}
        />
      )}
    </CountsChart>
  )
}

interface EnrichActionsProps {
  readonly fieldLabel: string
  readonly source: string
  readonly rowCount: number
  readonly unscored: number
  readonly disabled: boolean
  readonly onStart: (mode: EnrichMode) => void
}

function EnrichActions({ fieldLabel, source, rowCount, unscored, disabled, onStart }: EnrichActionsProps) {
  const { t } = useTranslation('settings')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const buttonClass =
    'px-2.5 py-1 text-xs font-medium rounded-md border disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      <button
        type="button"
        onClick={() => onStart('missing')}
        disabled={disabled || unscored === 0}
        className={`${buttonClass} border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100`}
      >
        {t('dataQuality.calculateMissing')}
      </button>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={disabled || rowCount === 0}
        className={`${buttonClass} border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100`}
      >
        {t('dataQuality.recalculateAll')}
      </button>
      <ConfirmModal
        isOpen={confirmOpen}
        title={t('dataQuality.recalculateTitle', { field: fieldLabel, source })}
        message={t('dataQuality.recalculateMessage', { field: fieldLabel, source, count: rowCount })}
        confirmLabel={t('dataQuality.recalculateAll')}
        cancelLabel={t('common:cancel')}
        variant="warning"
        onConfirm={() => {
          setConfirmOpen(false)
          onStart('all')
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
