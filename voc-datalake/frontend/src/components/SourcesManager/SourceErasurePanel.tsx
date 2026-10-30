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
 * The source keeps running: the dialog says so, and warns when the page-wide
 * `GET /sources/status` read (the one every source card shares) shows its
 * schedule on. A source with no schedule of its own (a Web Reviews page, a form)
 * gets the static text only.
 *
 * @module components/SourcesManager/SourceErasurePanel
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { api } from '../../api/client'
import { sourcesStatusKey } from '../../api/queryKeys'
import { sourceProfilesApi } from '../../api/sourceProfilesApi'
import type { ErasureJob, SourceProfile } from '../../api/sourceProfilesApi'
import type { SourcesStatus } from '../../api/sourcesStatusSchema'
import { sourceLabel } from '../../utils/displayLabels'
import DeleteSourceDataDialog from './DeleteSourceDataDialog'
import { ErasureSection, ErasureStartError, ErasureStatusBadge } from './erasureParts'
import { errorReason, useErasableSources, useErasureJobs, useStartErasure } from './useErasureJobs'

const PROGRESS_KEYS = {
  items: 'components:sourceErasure.progress.items',
  raw: 'components:sourceErasure.progress.raw',
  done: 'components:sourceErasure.progress.done',
} as const

function progressKey(job: ErasureJob): string {
  if (job.status === 'completed' || job.status === 'failed') return PROGRESS_KEYS.done
  return job.phase === 'raw' ? PROGRESS_KEYS.raw : PROGRESS_KEYS.items
}

/** Whether `GET /sources/status` shows `source`'s own schedule turned on (unknown reads as off). */
function isScheduleOn(status: SourcesStatus | undefined, source: string): boolean {
  const sources = status?.sources ?? {}
  return Object.hasOwn(sources, source) && sources[source]?.enabled === true
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
  const selectId = useId()
  const [source, setSource] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [startedId, setStartedId] = useState<string | null>(null)
  const { data: sources = [] } = useErasableSources()
  const { data: jobs = [] } = useErasureJobs()
  const { data: status } = useQuery({ queryKey: sourcesStatusKey(), queryFn: () => api.getSourcesStatus() })
  const scheduleOn = isScheduleOn(status, source)
  const started = jobs.find((job) => job.job_id === startedId)
  const start = useStartErasure((confirm: string) => sourceProfilesApi.startSourceErasure({ source, confirm }), {
    onAccepted: (job) => {
      setConfirming(false)
      setStartedId(job?.job_id ?? null)
    },
    onRefused: () => setConfirming(false),
  })

  return (
    <ErasureSection icon={Trash2} title={t('title')} description={t('description')}>
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
      {start.isError && <ErasureStartError text={t('startError', { reason: errorReason(start.error) })} />}
      {started !== undefined && <JobProgress job={started} />}
      {confirming && (
        <DeleteSourceDataDialog source={source} scheduleOn={scheduleOn} isPending={start.isPending}
          onConfirm={(typed) => start.mutate(typed)} onCancel={() => setConfirming(false)} />
      )}
    </ErasureSection>
  )
}
