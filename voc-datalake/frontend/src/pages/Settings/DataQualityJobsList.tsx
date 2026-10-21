/**
 * @fileoverview "Recent jobs" list on the Settings → Data Quality tab: what each
 * job targets, its status, a progress bar, its counters, and Cancel while it runs.
 *
 * Progress reads differently per kind. A profile job learns its total only at
 * the end, so while running it shows rows scanned so far over an indeterminate
 * bar. An enrich job's total grows while the planner is still enumerating rows
 * (`planned: false`), so processed/total is shown with a "still planning" note
 * until the plan is complete.
 *
 * @module pages/Settings/DataQualityJobsList
 */
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import clsx from 'clsx'
import { Loader2, X } from 'lucide-react'
import type { DataQualityJob } from '../../api/dataQualityApi'
import { formatTimestamp, isJobRunning, jobProgressPercent } from './dataQualityUtils'

const NEUTRAL_STATUS_STYLE = 'bg-gray-100 text-gray-600'

const STATUS_STYLES: Readonly<Record<string, string>> = {
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: NEUTRAL_STATUS_STYLE,
}

interface DataQualityJobsListProps {
  readonly jobs: readonly DataQualityJob[]
  readonly cancellingJobId: string | undefined
  readonly onCancel: (jobId: string) => void
}

export default function DataQualityJobsList({ jobs, cancellingJobId, onCancel }: DataQualityJobsListProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-3">{t('dataQuality.jobs.title')}</h2>
      {jobs.length === 0 ? (
        <p className="text-sm text-gray-500">{t('dataQuality.jobs.empty')}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {jobs.map((job) => (
            <JobRow
              key={job.job_id}
              job={job}
              isCancelling={cancellingJobId === job.job_id}
              onCancel={onCancel}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

interface JobRowProps {
  readonly job: DataQualityJob
  readonly isCancelling: boolean
  readonly onCancel: (jobId: string) => void
}

function JobRow({ job, isCancelling, onCancel }: JobRowProps) {
  const { t } = useTranslation('settings')
  const running = isJobRunning(job)
  return (
    <li className="py-3 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{jobTitle(job, t)}</span>
        <StatusBadge status={job.status} />
        <span className="text-xs text-gray-400">
          {t('dataQuality.jobs.started', { time: formatTimestamp(job.created_at) })}
        </span>
        {running && (
          <button
            type="button"
            onClick={() => onCancel(job.job_id)}
            disabled={isCancelling}
            className="ml-auto flex items-center gap-1 text-xs text-gray-500 hover:text-red-600 disabled:opacity-50"
          >
            {isCancelling ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            {t('dataQuality.jobs.cancel')}
          </button>
        )}
      </div>
      <JobProgress job={job} />
      {job.kind === 'enrich' && (
        <p className="text-xs text-gray-500">
          {t('dataQuality.jobs.counts', { updated: job.updated, skipped: job.skipped, failed: job.failed })}
        </p>
      )}
      {job.status === 'failed' && job.error && (
        <p className="text-xs text-red-600" role="alert">{job.error}</p>
      )}
    </li>
  )
}

/** "Refresh statistics", or "<Field> · <source> · <mode>" for an enrich job. */
function jobTitle(job: DataQualityJob, t: TFunction<'settings'>): string {
  if (job.kind === 'profile') return t('dataQuality.jobs.profile')
  const field = job.field ?? ''
  const target = t('dataQuality.jobs.enrich', {
    field: t(`dataQuality.fields.${field}`, { defaultValue: field }),
    source: job.source ?? '',
  })
  if (!job.mode) return target
  const modeLabel = t(`dataQuality.jobs.mode.${job.mode}`, { defaultValue: job.mode })
  return `${target} · ${modeLabel}`
}

function StatusBadge({ status }: { readonly status: string }) {
  const { t } = useTranslation('settings')
  return (
    <span className={clsx('px-2 py-0.5 text-xs font-medium rounded-full', STATUS_STYLES[status] ?? NEUTRAL_STATUS_STYLE)}>
      {t(`dataQuality.jobs.status.${status}`, { defaultValue: status })}
    </span>
  )
}

function JobProgress({ job }: { readonly job: DataQualityJob }) {
  const { t } = useTranslation('settings')
  const percent = jobProgressPercent(job)
  const running = isJobRunning(job)
  if (percent === null && !running) return null

  return (
    <div className="space-y-1">
      <ProgressBar percent={percent} label={t('dataQuality.jobs.progressLabel')} />
      <p className="text-xs text-gray-500">{progressText(job, t)}</p>
    </div>
  )
}

function progressText(job: DataQualityJob, t: TFunction<'settings'>): string {
  if (job.kind === 'profile') {
    return isJobRunning(job)
      ? t('dataQuality.jobs.scanning', { count: job.processed })
      : t('dataQuality.jobs.scanned', { count: Math.max(job.total, job.processed) })
  }
  const progress = t('dataQuality.jobs.progress', { processed: job.processed, total: job.total })
  return job.planned ? progress : `${progress} · ${t('dataQuality.jobs.planning')}`
}

/** A determinate bar, or an indeterminate one when `percent` is null. */
function ProgressBar({ percent, label }: { readonly percent: number | null; readonly label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden"
    >
      <div
        className={clsx('h-full rounded-full bg-blue-500 transition-all', percent === null && 'w-full animate-pulse opacity-60')}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  )
}
