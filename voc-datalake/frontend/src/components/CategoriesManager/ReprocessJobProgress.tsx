/**
 * @fileoverview A reprocess job's live progress: status, slice, counters, the raw-mode
 * fallback note, the configuration it derived with, and Cancel / Resume.
 *
 * Shared by the Categories reprocess panel and the Dimensions "Classify review types" card.
 *
 * @module components/CategoriesManager/ReprocessJobProgress
 */
import { useTranslation } from 'react-i18next'
import { Loader2, Play, Square } from 'lucide-react'
import { MAX_REPROCESS_ITEMS, isTerminalJob } from '../../api/reprocessApi'
import type { ReprocessJob, ReprocessRequest } from '../../api/reprocessApi'
import { formatCount } from '../../utils/numberFormat'
import { COUNTERS, STATUS, jobWindowLabel, modeTitleKey } from './reprocessCopy'

interface JobProgressProps {
  job: ReprocessJob
  onCancel: () => void
  cancelling: boolean
  /** Continue a partial job; absent where resuming is not offered. */
  onResume?: () => void
  resuming?: boolean
}

function SliceSummary({ job }: Readonly<{ job: ReprocessJob }>) {
  const { t } = useTranslation('components')
  if (job.sources.length === 0 && job.categories.length === 0) return null
  return (
    <p className="text-xs text-muted">
      {job.sources.length > 0 && t('categoriesManager.reprocess.sliceSources', { list: job.sources.join(', ') })}
      {job.sources.length > 0 && job.categories.length > 0 && ' · '}
      {job.categories.length > 0 && t('categoriesManager.reprocess.sliceCategories', { list: job.categories.join(', ') })}
    </p>
  )
}

function RawFallbackNote({ job }: Readonly<{ job: ReprocessJob }>) {
  const { t } = useTranslation('components')
  if (job.mode !== 'raw' || job.raw_fallback === 0) return null
  return (
    <p className="text-xs text-warn">
      {t('categoriesManager.reprocess.rawFallback', {
        count: job.raw_fallback, sources: job.raw_fallback_sources.join(', '),
      })}
    </p>
  )
}

function ConfigLine({ job }: Readonly<{ job: ReprocessJob }>) {
  const { t } = useTranslation('components')
  const { config } = job
  if (config === null) return null
  return (
    <p className="text-xs text-muted" data-testid="reprocess-config">
      {t('categoriesManager.reprocess.derivedWith', {
        model: config.model_id ?? '—',
        digest: config.categories_sha16 ?? '—',
        version: config.config_version ?? '—',
      })}
      {job.config_changed && <span className="text-warn"> {t('categoriesManager.reprocess.configChanged')}</span>}
    </p>
  )
}

function Ceiling({ job, onResume, resuming }: Readonly<Pick<JobProgressProps, 'job' | 'onResume' | 'resuming'>>) {
  const { t, i18n } = useTranslation('components')
  if (!job.stopped_at_ceiling) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-xs text-warn">
        {t('categoriesManager.reprocess.stoppedAtCeiling', { max: formatCount(MAX_REPROCESS_ITEMS, i18n.language) })}
      </p>
      {job.resumable && onResume !== undefined && (
        <button type="button" onClick={onResume} disabled={resuming === true} className="btn btn-secondary btn-sm">
          {resuming === true ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          {t('categoriesManager.reprocess.resume')}
        </button>
      )}
    </div>
  )
}

function JobProgress({ job, onCancel, cancelling, onResume, resuming }: Readonly<JobProgressProps>) {
  const { t, i18n } = useTranslation('components')
  const running = !isTerminalJob(job)
  const status = STATUS[job.status]
  return (
    <div className="rounded-md border border-border bg-bg-accent p-3 space-y-2" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge badge-${status.tone}`}>
          {running && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          {t(status.labelKey)}
        </span>
        <span className="text-xs text-muted">{t(modeTitleKey(job.mode))} · {jobWindowLabel(job, t)}</span>
        {running && (
          <button type="button" onClick={onCancel} disabled={cancelling} className="btn btn-danger btn-sm ml-auto">
            {cancelling ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}
            {t('categoriesManager.reprocess.cancel')}
          </button>
        )}
      </div>
      <SliceSummary job={job} />
      <dl className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        {COUNTERS.map((c) => (
          <div key={c.field}>
            <dt className="text-muted">{t(c.labelKey)}</dt>
            <dd className="font-mono text-text-strong">{formatCount(job[c.field], i18n.language)}</dd>
          </div>
        ))}
      </dl>
      <RawFallbackNote job={job} />
      <Ceiling job={job} onResume={onResume} resuming={resuming} />
      <ConfigLine job={job} />
      {job.error !== undefined && <p role="alert" className="text-xs text-danger">{job.error}</p>}
    </div>
  )
}

/** The two job controls a panel wires: cancel a running job, resume a partial one (``useReprocessMutations``). */
export interface JobControls {
  readonly start: { readonly mutate: (request: ReprocessRequest) => void; readonly isPending: boolean }
  readonly cancel: { readonly mutate: (jobId: string) => void; readonly isPending: boolean }
}

/** ``JobProgress`` with cancel and resume wired to the panel's mutations; resume only once the job stopped. */
export function LiveJobProgress({ job, controls }: Readonly<{ job: ReprocessJob; controls: JobControls }>) {
  const { start, cancel } = controls
  return (
    <JobProgress
      job={job}
      onCancel={() => cancel.mutate(job.job_id)}
      cancelling={cancel.isPending}
      onResume={isTerminalJob(job) ? () => start.mutate({ resume: job.job_id }) : undefined}
      resuming={start.isPending}
    />
  )
}
