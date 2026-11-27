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
import { useId, useMemo, useState } from 'react'
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
import { ErasureJobDetails, ErasureSection, ErasureStartError, ErasureStatusBadge } from './erasureParts'
import { errorReason, useErasableSources, useErasureJobs, useStartErasure } from './useErasureJobs'
import { jobReport } from './erasureOutcome'

type Phase = NonNullable<ErasureJob['phase']>
/** The phases with words of their own. A whole-source job never runs the members phase (only an erasure by email
 *  without a source does); it keeps its words, so a job row that ever names it still reads right. */
const PROGRESS_KEYS: Partial<Record<Phase, string>> = {
  items: 'components:sourceErasure.progress.items',
  radar: 'components:sourceErasure.progress.radar',
  boards: 'components:sourceErasure.progress.boards',
  members: 'components:sourceErasure.progress.members',
  raw: 'components:sourceErasure.progress.raw',
  lineage: 'components:sourceErasure.progress.lineage',
}
/** The worker's other phases (lambda/jobs/retention/handler.py `_phases`: the registries check, a form's test
 *  responses, the exports, the workspaces' projects and lineage, the participants, the agents' memory and the
 *  engineering lineage) read as one neutral step, never as "Deleting reviews" (7.97.00). */
const OTHER_PROGRESS_KEY = 'components:sourceErasure.progress.other'
const DONE_PROGRESS_KEY = 'components:sourceErasure.progress.done'

function progressKey(job: ErasureJob): string {
  if (job.status === 'completed' || job.status === 'failed') return DONE_PROGRESS_KEY
  return PROGRESS_KEYS[job.phase ?? 'items'] ?? OTHER_PROGRESS_KEY
}

/** Whether `GET /sources/status` shows `source`'s own schedule turned on (unknown reads as off). */
function isScheduleOn(status: SourcesStatus | undefined, source: string): boolean {
  const sources = status?.sources ?? {}
  return Object.hasOwn(sources, source) && sources[source]?.enabled === true
}

function JobProgress({ job, jobs }: Readonly<{ job: ErasureJob; jobs: readonly ErasureJob[] }>) {
  const { t } = useTranslation()
  const report = useMemo(() => jobReport(job, jobs), [job, jobs])
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-text">
      {/* Only the progress line is live: the details' review lists (up to 200 keys each) are read on demand. */}
      <p role="status" aria-live="polite" className="flex flex-wrap items-center gap-2">
        <ErasureStatusBadge report={report} />
        <span className="font-mono text-muted">{job.source}</span>
        <span>{t(progressKey(job), {
          items: job.deleted_items, objects: job.deleted_objects,
          rows: job.phase === 'members' ? job.member_rows_deidentified : job.board_items_deidentified,
        })}</span>
        {job.error !== undefined && <span className="text-danger">{job.error}</span>}
      </p>
      <ErasureJobDetails job={job} report={report} />
    </div>
  )
}

export default function SourceErasurePanel({ profiles }: Readonly<{ profiles: readonly SourceProfile[] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'sourceErasure' })
  const selectId = useId()
  const [source, setSource] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [startedId, setStartedId] = useState<string | null>(null)
  const { data: sources = [] } = useErasableSources()
  const { data: jobs = [] } = useErasureJobs('deployment')
  const { data: status } = useQuery({ queryKey: sourcesStatusKey(), queryFn: () => api.getSourcesStatus() })
  const scheduleOn = isScheduleOn(status, source)
  const started = jobs.find((job) => job.job_id === startedId)
  const start = useStartErasure(({ confirm, legalBasis }: { confirm: string; legalBasis: string }) =>
    sourceProfilesApi.startSourceErasure({ source, confirm, legalBasis }), {
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
      {started !== undefined && <JobProgress job={started} jobs={jobs} />}
      {confirming && (
        <DeleteSourceDataDialog source={source} scheduleOn={scheduleOn} isPending={start.isPending}
          onConfirm={(typed, legalBasis) => start.mutate({ confirm: typed, legalBasis })} onCancel={() => setConfirming(false)} />
      )}
    </ErasureSection>
  )
}
