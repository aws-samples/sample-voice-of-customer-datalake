/**
 * @fileoverview Erasure: delete every review (and its raw archive) that names
 * one person — by author, source id, CSV row id or email — optionally within
 * one source. Admin only; irreversible, so it asks first.
 *
 * The value is sent once and cleared from the form when the job is accepted;
 * the job list shows only what the server keeps (a hash of the value, counts).
 * The list polls while a job is queued or running.
 *
 * @module components/SourcesManager/ErasurePanel
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Eraser } from 'lucide-react'
import clsx from 'clsx'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import { ERASURE_FIELDS, erasureJobsKey, isLiveErasure, sourceProfilesApi } from '../../api/sourceProfilesApi'
import type { ErasureField, ErasureJob, ErasureStatus, SourceProfile } from '../../api/sourceProfilesApi'
import type { Tone } from '../../theme/tones'

const POLL_INTERVAL_MS = 2_000

const FIELD_COPY: Record<ErasureField, { labelKey: string }> = {
  author: { labelKey: 'components:erasure.fields.author' },
  source_id: { labelKey: 'components:erasure.fields.source_id' },
  csv_row_id: { labelKey: 'components:erasure.fields.csv_row_id' },
  email: { labelKey: 'components:erasure.fields.email' },
}

const STATUS: Record<ErasureStatus, { tone: Tone; labelKey: string }> = {
  queued: { tone: 'muted', labelKey: 'components:erasure.status.queued' },
  running: { tone: 'info', labelKey: 'components:erasure.status.running' },
  completed: { tone: 'ok', labelKey: 'components:erasure.status.completed' },
  failed: { tone: 'danger', labelKey: 'components:erasure.status.failed' },
}

/** An item id / CSV row id is unique only within a source, so the API requires `source` for these. */
const SOURCE_SCOPED_FIELDS: ReadonlySet<ErasureField> = new Set<ErasureField>(['source_id', 'csv_row_id'])

function isErasureField(value: string): value is ErasureField {
  return ERASURE_FIELDS.some((f) => f === value)
}

function JobRow({ job }: Readonly<{ job: ErasureJob }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  const { t: tAll } = useTranslation()
  const status = STATUS[job.status]
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs py-2 border-t border-border first:border-t-0">
      <span className={clsx('badge', `badge-${status.tone}`)}>{tAll(status.labelKey)}</span>
      <span className="text-text">{tAll(FIELD_COPY[job.field].labelKey)}</span>
      {job.source !== undefined && <span className="font-mono text-muted">{job.source}</span>}
      <span className="font-mono text-muted" title={job.value_hash}>{job.value_hash.slice(0, 12)}</span>
      <span className="text-text">{t('counts', { items: job.deleted_items, objects: job.deleted_objects })}</span>
      <span className="text-muted">{job.started_by} · {job.created_at}</span>
      {job.error !== undefined && <span className="text-danger">{job.error}</span>}
    </li>
  )
}

function useErasureJobs() {
  return useQuery({
    queryKey: erasureJobsKey(),
    queryFn: () => sourceProfilesApi.listErasureJobs(),
    refetchInterval: (query) => ((query.state.data ?? []).some(isLiveErasure) ? POLL_INTERVAL_MS : false),
  })
}

export default function ErasurePanel({ profiles }: Readonly<{ profiles: readonly SourceProfile[] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  const { t: tAll } = useTranslation()
  const titleId = useId()
  const fieldId = useId()
  const valueId = useId()
  const sourceId = useId()
  const queryClient = useQueryClient()
  const [field, setField] = useState<ErasureField>('author')
  const [value, setValue] = useState('')
  const [source, setSource] = useState('')
  const [confirming, setConfirming] = useState(false)
  const { data: jobs = [] } = useErasureJobs()
  const needsSource = SOURCE_SCOPED_FIELDS.has(field) && source === ''
  const hintId = useId()
  const start = useMutation({
    mutationFn: () => sourceProfilesApi.startErasure({ field, value: value.trim(), source }),
    onSuccess: () => {
      setValue('')
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: erasureJobsKey() })
    },
    onError: () => setConfirming(false),
  })

  return (
    <section className="rounded-lg border border-danger/30 p-3 sm:p-4 space-y-3" aria-labelledby={titleId}>
      <div className="flex items-center gap-2">
        <Eraser size={16} className="text-danger" aria-hidden="true" />
        <h3 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong">{t('title')}</h3>
      </div>
      <p className="text-sm text-muted">{t('description')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={fieldId} className="block text-xs font-medium text-text mb-1">{t('fieldLabel')}</label>
          <select id={fieldId} value={field} onChange={(e) => { if (isErasureField(e.target.value)) setField(e.target.value) }} className="select">
            {ERASURE_FIELDS.map((f) => <option key={f} value={f}>{tAll(FIELD_COPY[f].labelKey)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={valueId} className="block text-xs font-medium text-text mb-1">{t('valueLabel')}</label>
          <input id={valueId} type="text" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} className="input" />
        </div>
        <div>
          <label htmlFor={sourceId} className="block text-xs font-medium text-text mb-1">{t('sourceLabel')}</label>
          <select id={sourceId} value={source} onChange={(e) => setSource(e.target.value)} className="select"
            aria-describedby={needsSource ? hintId : undefined}>
            <option value="">{t('allSources')}</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {needsSource && <p id={hintId} className="text-xs text-muted mt-1">{t('sourceRequired')}</p>}
        </div>
      </div>
      <button type="button" onClick={() => setConfirming(true)} disabled={value.trim() === '' || needsSource || start.isPending} className="btn btn-danger">
        <Eraser size={14} aria-hidden="true" /> {t('start')}
      </button>
      {start.isError && (
        <p role="alert" className="text-sm text-text flex items-center gap-2 bg-danger-subtle border border-danger/30 rounded-md px-3 py-2">
          <AlertCircle size={14} className="text-danger flex-shrink-0" aria-hidden="true" />
          {t('startError', { reason: start.error instanceof Error ? start.error.message : '' })}
        </p>
      )}
      <div>
        <h4 className="text-xs font-medium text-text mb-1">{t('jobsTitle')}</h4>
        {jobs.length === 0 ? <p className="text-xs text-muted">{t('noJobs')}</p> : (
          <ul>{jobs.map((job) => <JobRow key={job.job_id} job={job} />)}</ul>
        )}
      </div>
      <ConfirmModal
        isOpen={confirming}
        title={t('confirmTitle')}
        message={t('confirmMessage', { field: tAll(FIELD_COPY[field].labelKey), source: source === '' ? t('allSources') : source })}
        confirmLabel={t('start')}
        variant="danger"
        isLoading={start.isPending}
        onConfirm={() => start.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </section>
  )
}
