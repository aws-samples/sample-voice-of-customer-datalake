/**
 * @fileoverview "Classify review types for existing reviews": the button that fills the
 * built-in `feedback_type` dimension on reviews stored before it existed (admin only).
 *
 * It starts the existing reprocess job in `dimensions` mode over all time without
 * touching manual values (`POST /settings/categories/reprocess`), so it costs one
 * enrichment-model call per review (that call re-checks every inferred dimension).
 * New reviews are typed by the processor on arrival; nothing starts this by itself.
 * The count comes from `GET /metrics/dimensions?key=feedback_type&days=0`
 * (`unassigned` = reviews with no type yet).
 *
 * @module components/DimensionsManager/FeedbackTypeBackfill
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Tags } from 'lucide-react'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { ALL_TIME_CUSTOM_DAYS } from '../../api/baseUrl'
import { dimensionMetricsKey, dimensionsApi } from '../../api/dimensionsApi'
import { FEEDBACK_TYPE_KEY } from '../../api/feedbackTypes'
import { isTerminalJob } from '../../api/reprocessApi'
import { useConfigStore } from '../../store/configStore'
import { formatCount } from '../../utils/numberFormat'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import { JobProgress } from '../CategoriesManager/ReprocessPanel'
import { useLatestJob, useReprocessMutations } from '../CategoriesManager/useReprocessJob'
import type { DimensionMetrics } from '../../api/dimensionsSchema'

const METRICS_PARAMS = { key: FEEDBACK_TYPE_KEY, days: ALL_TIME_CUSTOM_DAYS }

function useTypeCounts() {
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  return useQuery({
    queryKey: dimensionMetricsKey(METRICS_PARAMS),
    queryFn: () => dimensionsApi.getMetrics(METRICS_PARAMS),
    enabled: !!apiEndpoint,
  })
}

function typedCount(metrics: DimensionMetrics): number {
  return metrics.values.reduce((sum, value) => sum + value.count, 0)
}

function CountLine({ metrics }: Readonly<{ metrics: DimensionMetrics | undefined }>) {
  const { t, i18n } = useTranslation('components', { keyPrefix: 'dimensionsManager.feedbackTypeBackfill' })
  if (metrics === undefined) return null
  const untyped = formatCount(metrics.unassigned, i18n.language)
  const typed = formatCount(typedCount(metrics), i18n.language)
  return (
    <p className="text-sm text-text">
      {t(metrics.isPartial ? 'countsPartial' : 'counts', { untyped, typed })}
    </p>
  )
}

export default function FeedbackTypeBackfill() {
  const { t } = useTranslation('components', { keyPrefix: 'dimensionsManager.feedbackTypeBackfill' })
  const [confirming, setConfirming] = useState(false)
  const { data: metrics } = useTypeCounts()
  const { data: job } = useLatestJob()
  const { start, cancel } = useReprocessMutations(() => setConfirming(false))
  const busy = job != null && !isTerminalJob(job)
  // The job re-reads EVERY stored review in the window (typed ones too), so the cost is the total.
  const total = metrics === undefined ? 0 : metrics.unassigned + typedCount(metrics)

  return (
    <div className="rounded-md border border-border bg-bg-accent p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Tags size={16} className="text-accent" aria-hidden="true" />
        <h4 className="text-sm font-semibold text-text-strong">{t('title')}</h4>
      </div>
      <p className="text-xs text-muted">{t('description')}</p>
      <CountLine metrics={metrics} />
      <p className="text-xs text-warn">{t('costNote')}</p>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={busy || start.isPending}
        className="btn btn-primary btn-sm"
      >
        <Tags size={14} aria-hidden="true" />
        {t('start')}
      </button>
      {start.isError && (
        <p role="alert" className="text-sm text-text flex items-center gap-2">
          <AlertCircle size={14} className="text-danger flex-shrink-0" aria-hidden="true" />
          {apiErrorStatus(start.error) === 409 ? t('alreadyRunning') : t('startError')}
        </p>
      )}
      {job?.mode === 'dimensions' && (
        <JobProgress job={job} onCancel={() => cancel.mutate(job.job_id)} cancelling={cancel.isPending} />
      )}
      <ConfirmModal
        isOpen={confirming}
        title={t('confirmTitle')}
        message={t('confirmMessage', { total })}
        confirmLabel={t('start')}
        variant="warning"
        isLoading={start.isPending}
        onConfirm={() => start.mutate({ mode: 'dimensions', days: ALL_TIME_CUSTOM_DAYS, include_manual: false })}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}
