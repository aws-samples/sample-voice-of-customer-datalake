/**
 * JobsSection - Displays background jobs for a project
 */
import clsx from 'clsx'
import { format } from 'date-fns'
import {
  Clock, Loader2, CheckCircle, XCircle, X,
} from 'lucide-react'
import {
  useState, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import JobStatusBadge from './JobStatusBadge'
import type { ProjectJob } from '../../api/types'

type JobStatus = 'running' | 'pending' | 'completed' | 'failed'

function isValidJobStatus(status: string): status is JobStatus {
  return status === 'running' || status === 'pending' || status === 'completed' || status === 'failed'
}

interface JobsSectionProps {
  readonly jobs: ProjectJob[]
  readonly onDismiss: (jobId: string) => void
}

const STALE_THRESHOLD_MS = 10 * 60 * 1000

function checkIsStale(status: string, updatedAt: string | undefined, now: number): boolean {
  if (status !== 'running' && status !== 'pending') return false
  if ((updatedAt == null || updatedAt === '')) return false
  return new Date(updatedAt).getTime() < now - STALE_THRESHOLD_MS
}

interface JobItemProps {
  readonly job: ProjectJob
  readonly isStale: boolean
  readonly onDismiss: (jobId: string) => void
}

function JobProgressBar({ job }: { readonly job: ProjectJob }) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
        <span>{job.current_step?.replaceAll('_', ' ') ?? t('jobs.starting')}</span>
        <span>{job.progress}%</span>
      </div>
      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-600 transition-all duration-500"
          style={{ width: `${job.progress}%` }}
        />
      </div>
    </div>
  )
}

function hasCompletedResult(job: ProjectJob): boolean {
  return job.status === 'completed'
    && ((job.result?.document_id != null && job.result.document_id !== '')
      || (job.result?.persona_id != null && job.result.persona_id !== ''))
}

function getCompletedLabel(job: ProjectJob): string {
  return job.result?.title ?? job.result?.document_id ?? job.result?.persona_id ?? ''
}

function JobStatusMessage({
  job, isStale, showProgress,
}: {
  readonly job: ProjectJob
  readonly isStale: boolean
  readonly showProgress: boolean
}) {
  const { t } = useTranslation('projectDetail')
  if (isStale) {
    return (
      <p className="text-xs text-amber-600 mt-1">
        {t('jobs.staleMessage')}
      </p>
    )
  }
  if (showProgress) {
    return <JobProgressBar job={job} />
  }
  if (hasCompletedResult(job)) {
    return (
      <p className="text-xs text-gray-500 mt-1">
        {t('jobs.created')} {getCompletedLabel(job)}
      </p>
    )
  }
  if (job.status === 'failed' && job.error != null && job.error !== '') {
    return <p className="text-xs text-red-600 mt-1 truncate">{job.error}</p>
  }
  return null
}

function JobItemContent({
  job, isStale,
}: {
  readonly job: ProjectJob;
  readonly isStale: boolean
}) {
  const { t } = useTranslation('projectDetail')
  const status = isValidJobStatus(job.status) ? job.status : 'pending'
  const showProgress = !isStale && (job.status === 'running' || job.status === 'pending')

  const jobTypeKey = {
    research: 'jobs.types.research',
    generate_prd: 'jobs.types.generatePrd',
    generate_prfaq: 'jobs.types.generatePrfaq',
    generate_personas: 'jobs.types.generatePersonas',
    import_persona: 'jobs.types.importPersona',
    merge_documents: 'jobs.types.mergeDocuments',
  }[job.job_type]

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm">{t(jobTypeKey)}</span>
        <JobStatusBadge status={status} isStale={isStale} />
      </div>
      <JobStatusMessage job={job} isStale={isStale} showProgress={showProgress} />
    </div>
  )
}

function JobItemActions({
  job, isStale, onDismiss,
}: JobItemProps) {
  const showDismiss = job.status === 'completed' || job.status === 'failed' || isStale

  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      <span className="text-xs text-gray-400">
        {format(new Date(job.created_at), 'HH:mm')}
      </span>
      {showDismiss ? <button
        onClick={() => onDismiss(job.job_id)}
        className="p-1 hover:bg-gray-200 rounded text-gray-400 hover:text-gray-600"
        title="Dismiss"
      >
        <X size={14} />
      </button> : null}
    </div>
  )
}

function JobItem({
  job, isStale, onDismiss,
}: JobItemProps) {
  return (
    <div
      className={clsx(
        'flex items-center gap-4 p-3 rounded-lg',
        isStale ? 'bg-amber-50 border border-amber-200' : 'bg-gray-50',
      )}
    >
      <JobIcon status={job.status} isStale={isStale} />
      <JobItemContent job={job} isStale={isStale} />
      <JobItemActions job={job} isStale={isStale} onDismiss={onDismiss} />
    </div>
  )
}

function JobsSectionHeader() {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
        <Clock size={20} className="text-gray-600" />
      </div>
      <div>
        <h3 className="font-semibold">{t('jobs.backgroundJobs')}</h3>
        <p className="text-sm text-gray-500">{t('jobs.backgroundJobsDesc')}</p>
      </div>
    </div>
  )
}

export default function JobsSection({
  jobs, onDismiss,
}: JobsSectionProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(interval)
  }, [])

  if (jobs.length === 0) return null

  return (
    <div className="bg-white rounded-xl p-6 border">
      <JobsSectionHeader />
      <div className="space-y-3">
        {jobs.slice(0, 5).map((job) => (
          <JobItem
            key={job.job_id}
            job={job}
            isStale={checkIsStale(job.status, job.updated_at, now)}
            onDismiss={onDismiss}
          />
        ))}
      </div>
    </div>
  )
}

function JobIcon({
  status, isStale,
}: {
  readonly status: string;
  readonly isStale: boolean
}) {
  if (isStale) {
    return <Clock size={20} className="text-amber-600 flex-shrink-0" />
  }
  if (status === 'running' || status === 'pending') {
    return <Loader2 size={20} className="text-blue-600 animate-spin flex-shrink-0" />
  }
  if (status === 'completed') {
    return <CheckCircle size={20} className="text-green-600 flex-shrink-0" />
  }
  return <XCircle size={20} className="text-red-600 flex-shrink-0" />
}
