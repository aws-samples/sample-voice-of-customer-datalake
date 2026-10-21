/**
 * @fileoverview Admin-only Settings → Data Quality tab.
 *
 * Shows the last per-source profile snapshot (rating, sentiment, enrichment-field
 * and text-length distributions) and starts the async jobs that refresh it or
 * fill in / recalculate an LLM enrichment field for one source. Jobs run in a
 * background worker; this tab only starts them and polls their progress (see
 * `useDataQuality`). The routes are admin-gated server-side too — the tab renders
 * only for admins, mirroring CustomFiltersSection.
 *
 * @module pages/Settings/DataQualitySection
 */
import { useTranslation } from 'react-i18next'
import { AlertCircle, Gauge, Loader2, RefreshCw } from 'lucide-react'
import type {
  DataQualityResponse,
  DataQualitySourceStats,
  StartDataQualityJobBody,
} from '../../api/dataQualityApi'
import DataQualityJobsList from './DataQualityJobsList'
import DataQualitySourceCard from './DataQualitySourceCard'
import { formatTimestamp, isProfileRunning } from './dataQualityUtils'
import { useDataQuality } from './useDataQuality'

interface DataQualitySectionProps {
  readonly apiEndpoint: string
  /** Renders only for admins — the backend gates every route server-side too. */
  readonly isAdmin: boolean
}

export default function DataQualitySection({ apiEndpoint, isAdmin }: DataQualitySectionProps) {
  const { t } = useTranslation('settings')
  const enabled = isAdmin && apiEndpoint.length > 0
  const {
    data, isLoading, isError, actionError, startJob, isStarting, cancelJob, cancellingJobId,
  } = useDataQuality(enabled)

  if (!enabled) return null

  return (
    <div className="space-y-6">
      <div className="card">
        <SectionHeader
          // Nothing to refresh against until the first read lands.
          canRefresh={data !== undefined && !isStarting}
          profileRunning={isProfileRunning(data?.jobs ?? [])}
          onRefresh={() => startJob({ kind: 'profile' })}
        />
        {actionError && (
          <p className="mt-3 flex items-center gap-2 text-sm text-red-600" role="alert">
            <AlertCircle size={16} className="shrink-0" /> {t(`dataQuality.${actionError}`)}
          </p>
        )}
        <div className="mt-3">
          <SnapshotStatus data={data} isLoading={isLoading} isError={isError} />
        </div>
      </div>

      {data?.stats && (
        <SourceGrid data={data} sources={data.stats.sources} isStarting={isStarting} onStart={startJob} />
      )}

      {data && (
        <DataQualityJobsList jobs={data.jobs} cancellingJobId={cancellingJobId} onCancel={cancelJob} />
      )}
    </div>
  )
}

interface SectionHeaderProps {
  readonly canRefresh: boolean
  readonly profileRunning: boolean
  readonly onRefresh: () => void
}

function SectionHeader({ canRefresh, profileRunning, onRefresh }: SectionHeaderProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Gauge size={18} className="text-blue-600" />
          <h2 className="text-lg font-semibold">{t('dataQuality.title')}</h2>
        </div>
        <p className="text-xs text-gray-500">{t('dataQuality.intro')}</p>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={!canRefresh || profileRunning}
        className="btn-primary text-sm flex items-center justify-center gap-2 shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <RefreshCw size={14} className={profileRunning ? 'animate-spin' : undefined} />
        {t('dataQuality.refresh')}
      </button>
    </div>
  )
}

interface SnapshotStatusProps {
  readonly data: DataQualityResponse | undefined
  readonly isLoading: boolean
  readonly isError: boolean
}

function SnapshotStatus({ data, isLoading, isError }: SnapshotStatusProps) {
  const { t } = useTranslation('settings')
  if (isError) {
    return (
      <p className="flex items-center gap-2 text-sm text-red-600" role="alert">
        <AlertCircle size={16} /> {t('dataQuality.loadFailed')}
      </p>
    )
  }
  if (isLoading || !data) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" /> {t('dataQuality.loading')}
      </p>
    )
  }
  if (!data.stats) {
    return <p className="text-sm text-gray-500">{t('dataQuality.noStats')}</p>
  }
  return (
    <p className="text-xs text-gray-500">
      {t('dataQuality.snapshot', { time: formatTimestamp(data.stats.generated_at), count: data.stats.scanned })}
    </p>
  )
}

interface SourceGridProps {
  readonly data: DataQualityResponse
  readonly sources: readonly DataQualitySourceStats[]
  readonly isStarting: boolean
  readonly onStart: (body: StartDataQualityJobBody) => void
}

function SourceGrid({ data, sources, isStarting, onStart }: SourceGridProps) {
  const { t } = useTranslation('settings')
  if (sources.length === 0) {
    return <div className="card text-sm text-gray-500">{t('dataQuality.noSources')}</div>
  }
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {sources.map((stats) => (
        <DataQualitySourceCard
          key={stats.source}
          stats={stats}
          fields={data.fields}
          jobs={data.jobs}
          isStarting={isStarting}
          onStart={onStart}
        />
      ))}
    </div>
  )
}
