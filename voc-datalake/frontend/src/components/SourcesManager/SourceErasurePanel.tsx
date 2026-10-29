/**
 * @fileoverview "Delete all data from a source": every review of one source and
 * every raw file under its `raw/<source>/` folder, as one erasure job
 * (`POST /settings/erasure` with `field: 'source'`). Admin only; irreversible,
 * so the dialog asks for the source id to be typed.
 *
 * The picker lists what the server accepts (`GET /settings/erasure` → `sources`:
 * configured profiles plus every source with counted data). The started job's
 * progress (reviews, then raw files) comes from the shared, polled job list.
 *
 * @module components/SourcesManager/SourceErasurePanel
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Trash2 } from 'lucide-react'
import { erasableSourcesKey, erasureJobsKey, sourceProfilesApi } from '../../api/sourceProfilesApi'
import type { ErasureJob, SourceProfile } from '../../api/sourceProfilesApi'
import { sourceLabel } from '../../utils/displayLabels'
import DeleteSourceDataDialog from './DeleteSourceDataDialog'
import { ErasureStatusBadge } from './ErasurePanel'
import { useErasureJobs } from './useErasureJobs'

const PROGRESS_KEYS = {
  items: 'components:sourceErasure.progress.items',
  raw: 'components:sourceErasure.progress.raw',
  done: 'components:sourceErasure.progress.done',
} as const

function progressKey(job: ErasureJob): string {
  if (job.status === 'completed' || job.status === 'failed') return PROGRESS_KEYS.done
  return job.phase === 'raw' ? PROGRESS_KEYS.raw : PROGRESS_KEYS.items
}

function JobProgress({ job }: Readonly<{ job: ErasureJob }>) {
  const { t } = useTranslation()
  return (
    <p role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 text-xs text-text">
      <ErasureStatusBadge status={job.status} />
      <span className="font-mono text-muted">{job.source}</span>
      <span>{t(progressKey(job), { items: job.deleted_items, objects: job.deleted_objects })}</span>
      {job.error !== undefined && <span className="text-danger">{job.error}</span>}
    </p>
  )
}

export default function SourceErasurePanel({ profiles }: Readonly<{ profiles: readonly SourceProfile[] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'sourceErasure' })
  const titleId = useId()
  const selectId = useId()
  const queryClient = useQueryClient()
  const [source, setSource] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [startedId, setStartedId] = useState<string | null>(null)
  const { data: sources = [] } = useQuery({ queryKey: erasableSourcesKey(), queryFn: () => sourceProfilesApi.listErasableSources() })
  const { data: jobs = [] } = useErasureJobs()
  const started = jobs.find((job) => job.job_id === startedId)
  const start = useMutation({
    mutationFn: (confirm: string) => sourceProfilesApi.startSourceErasure({ source, confirm }),
    onSuccess: (job) => {
      setConfirming(false)
      setStartedId(job?.job_id ?? null)
      void queryClient.invalidateQueries({ queryKey: erasureJobsKey() })
    },
    onError: () => setConfirming(false),
  })

  return (
    <section className="rounded-lg border border-danger/30 p-3 sm:p-4 space-y-3" aria-labelledby={titleId}>
      <div className="flex items-center gap-2">
        <Trash2 size={16} className="text-danger" aria-hidden="true" />
        <h3 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong">{t('title')}</h3>
      </div>
      <p className="text-sm text-muted">{t('description')}</p>
      {sources.length === 0 ? <p className="text-xs text-muted">{t('noSources')}</p> : (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={selectId} className="block text-xs font-medium text-text mb-1">{t('sourceLabel')}</label>
            <select id={selectId} value={source} onChange={(e) => setSource(e.target.value)} className="select">
              <option value="">{t('chooseSource')}</option>
              {sources.map((id) => <option key={id} value={id}>{sourceLabel(id, profiles)}</option>)}
            </select>
          </div>
          <button type="button" onClick={() => setConfirming(true)} disabled={source === '' || start.isPending} className="btn btn-danger">
            <Trash2 size={14} aria-hidden="true" /> {t('start')}
          </button>
        </div>
      )}
      {start.isError && (
        <p role="alert" className="text-sm text-text flex items-center gap-2 bg-danger-subtle border border-danger/30 rounded-md px-3 py-2">
          <AlertCircle size={14} className="text-danger flex-shrink-0" aria-hidden="true" />
          {t('startError', { reason: start.error instanceof Error ? start.error.message : '' })}
        </p>
      )}
      {started !== undefined && <JobProgress job={started} />}
      {confirming && (
        <DeleteSourceDataDialog source={source} isPending={start.isPending}
          onConfirm={(typed) => start.mutate(typed)} onCancel={() => setConfirming(false)} />
      )}
    </section>
  )
}
