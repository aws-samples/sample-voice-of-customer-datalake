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
import { Eraser } from 'lucide-react'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import { ERASURE_FIELDS, sourceProfilesApi } from '../../api/sourceProfilesApi'
import type { ErasureField, ErasureJob, ErasureJobField, SourceProfile } from '../../api/sourceProfilesApi'
import { sourceLabel } from '../../utils/displayLabels'
import { ErasureSection, ErasureStartError, ErasureStatusBadge } from './erasureParts'
import { errorReason, useErasureJobs, useStartErasure } from './useErasureJobs'

const FIELD_COPY: Record<ErasureJobField, { labelKey: string }> = {
  author: { labelKey: 'components:erasure.fields.author' },
  source_id: { labelKey: 'components:erasure.fields.source_id' },
  csv_row_id: { labelKey: 'components:erasure.fields.csv_row_id' },
  email: { labelKey: 'components:erasure.fields.email' },
  source: { labelKey: 'components:erasure.fields.source' },
}

/** An item id / CSV row id is unique only within a source, so the API requires `source` for these. */
const SOURCE_SCOPED_FIELDS: ReadonlySet<ErasureField> = new Set<ErasureField>(['source_id', 'csv_row_id'])

function isErasureField(value: string): value is ErasureField {
  return ERASURE_FIELDS.some((f) => f === value)
}

function JobRow({ job }: Readonly<{ job: ErasureJob }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  const { t: tAll } = useTranslation()
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs py-2 border-t border-border first:border-t-0">
      <ErasureStatusBadge status={job.status} />
      <span className="text-text">{tAll(FIELD_COPY[job.field].labelKey)}</span>
      {job.source !== undefined && <span className="font-mono text-muted">{job.source}</span>}
      <span className="font-mono text-muted" title={job.value_hash}>{job.value_hash.slice(0, 12)}</span>
      <span className="text-text">{t('counts', { items: job.deleted_items, objects: job.deleted_objects })}</span>
      <span className="text-muted">{job.started_by} · {job.created_at}</span>
      {job.error !== undefined && <span className="text-danger">{job.error}</span>}
    </li>
  )
}

export default function ErasurePanel({ profiles }: Readonly<{ profiles: readonly SourceProfile[] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  const { t: tAll } = useTranslation()
  const fieldId = useId()
  const valueId = useId()
  const sourceId = useId()
  const [field, setField] = useState<ErasureField>('author')
  const [value, setValue] = useState('')
  const [source, setSource] = useState('')
  const [confirming, setConfirming] = useState(false)
  const { data: jobs = [] } = useErasureJobs()
  const needsSource = SOURCE_SCOPED_FIELDS.has(field) && source === ''
  const hintId = useId()
  const start = useStartErasure(() => sourceProfilesApi.startErasure({ field, value: value.trim(), source }), {
    onAccepted: () => {
      setValue('')
      setConfirming(false)
    },
    onRefused: () => setConfirming(false),
  })

  return (
    <ErasureSection icon={Eraser} title={t('title')} description={t('description')}>
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
            {profiles.map((p) => <option key={p.id} value={p.id}>{sourceLabel(p.id, profiles)}</option>)}
          </select>
          {needsSource && <p id={hintId} className="text-xs text-muted mt-1">{t('sourceRequired')}</p>}
        </div>
      </div>
      <button type="button" onClick={() => setConfirming(true)} disabled={value.trim() === '' || needsSource || start.isPending} className="btn btn-danger">
        <Eraser size={14} aria-hidden="true" /> {t('start')}
      </button>
      {start.isError && <ErasureStartError text={t('startError', { reason: errorReason(start.error) })} />}
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
        onConfirm={() => start.mutate(undefined)}
        onCancel={() => setConfirming(false)}
      />
    </ErasureSection>
  )
}
