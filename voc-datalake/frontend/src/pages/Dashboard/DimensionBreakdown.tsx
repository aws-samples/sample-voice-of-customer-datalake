/**
 * @fileoverview "By dimension" on the Dashboard: pick a configured dimension
 * and see each value's review count with its sentiment split
 * (`GET /metrics/dimensions`). Reviews with no value for the dimension are a
 * separate "Unassigned" row.
 *
 * Rendered only when dimensions are configured. The split bar is decorative
 * (`aria-hidden`); each row states its counts in text.
 *
 * @module pages/Dashboard/DimensionBreakdown
 */
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'
import { dimensionMetricsKey, dimensionsApi } from '../../api/dimensionsApi'
import { valueLabel } from '../../api/dimensionsSchema'
import { useDimensionsConfig } from '../../hooks/useDimensions'
import { sentimentCssVar } from '../../lib/sentiment'
import DashboardCard from './DashboardCard'
import { partialHintText } from './dashboardData'
import type { DateRangeParams } from '../../api/client'
import type { Dimension, DimensionBucket } from '../../api/dimensionsSchema'

const SENTIMENTS = ['positive', 'neutral', 'mixed', 'negative'] as const

function SplitBar({ bucket, max }: Readonly<{ bucket: DimensionBucket; max: number }>) {
  const width = max === 0 ? 0 : (bucket.count / max) * 100
  return (
    <div className="h-2 rounded-full bg-bg-hover overflow-hidden" aria-hidden="true">
      <div className="h-full flex" style={{ width: `${width}%` }}>
        {SENTIMENTS.map((s) => (
          bucket[s] > 0 && <div key={s} className="h-full" style={{ flexGrow: bucket[s], background: sentimentCssVar(s) }} />
        ))}
      </div>
    </div>
  )
}

function ValueRow({ label, bucket, max }: Readonly<{ label: string; bucket: DimensionBucket; max: number }>) {
  const { t } = useTranslation('dashboard', { keyPrefix: 'byDimension' })
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-text-strong truncate">{label}</span>
        <span className="font-mono text-text">{bucket.count}</span>
      </div>
      <SplitBar bucket={bucket} max={max} />
      <p className="text-xs text-muted">
        {t('split', { positive: bucket.positive, neutral: bucket.neutral, mixed: bucket.mixed, negative: bucket.negative })}
      </p>
    </li>
  )
}

function Breakdown({ dimension, dateParams }: Readonly<{ dimension: Dimension; dateParams: DateRangeParams }>) {
  const { t } = useTranslation(['dashboard', 'common'])
  const params = { ...dateParams, key: dimension.key }
  const { data, isLoading, isError } = useQuery({
    queryKey: dimensionMetricsKey(params),
    queryFn: () => dimensionsApi.getMetrics(params),
  })
  if (isLoading) return <div className="skeleton h-24" />
  if (isError || data === undefined) return <p role="alert" className="text-sm text-danger">{t('dashboard:byDimension.loadError')}</p>
  if (data.values.length === 0 && data.unassigned === 0) return <p className="text-sm text-muted">{t('dashboard:byDimension.empty')}</p>
  const max = Math.max(data.unassigned, ...data.values.map((v) => v.count))
  const hint = partialHintText(data.isPartial, null, t)
  return (
    <>
      <ul className="space-y-3">
        {data.values.map((v) => <ValueRow key={v.name} label={valueLabel(dimension, v.name)} bucket={v} max={max} />)}
      </ul>
      {data.unassigned > 0 && (
        <p className="text-xs text-muted mt-3">{t('dashboard:byDimension.unassigned', { n: data.unassigned })}</p>
      )}
      {hint !== undefined && <p className="text-xs text-warn mt-2">{hint}</p>}
    </>
  )
}

export default function DimensionBreakdown({ dateParams }: Readonly<{ dateParams: DateRangeParams }>) {
  const { t } = useTranslation('dashboard', { keyPrefix: 'byDimension' })
  const selectId = useId()
  const { data } = useDimensionsConfig()
  const dimensions = data?.dimensions ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const dimension = dimensions.find((d) => d.key === picked) ?? dimensions[0]
  if (dimension === undefined) return null
  return (
    <DashboardCard icon={<Layers className="text-accent-text flex-shrink-0" size={18} aria-hidden="true" />} title={t('title')}>
      <div className="mb-4">
        <label htmlFor={selectId} className="sr-only">{t('pick')}</label>
        <select id={selectId} value={dimension.key} onChange={(e) => setPicked(e.target.value)} className="select select-sm w-auto">
          {dimensions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
      </div>
      <Breakdown dimension={dimension} dateParams={dateParams} />
    </DashboardCard>
  )
}
