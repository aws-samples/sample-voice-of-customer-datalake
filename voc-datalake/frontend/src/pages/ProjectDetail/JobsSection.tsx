/**
 * JobsSection - Displays background jobs for a project.
 *
 * This panel renders above the tab content on every project tab, so whatever it
 * shows outranks the content the user came for. It therefore shows only work
 * that still needs attention — running, pending and failed jobs — and puts
 * completed ones to rest behind a one-line summary.
 *
 * Failures deliberately stay expanded alongside running work: a completion is
 * self-explanatory and read at a glance, a failure is neither, and since the
 * long-running actions hand their wait to this panel (see ProjectDetail's
 * onJobStarted) this is the only place a failed build is reported.
 */
import clsx from 'clsx'
import { isToday, isValid } from 'date-fns'
import {
  Clock, Loader2, CheckCircle, XCircle, X, ChevronDown, ChevronRight,
} from 'lucide-react'
import {
  useState, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import JobStatusBadge from './JobStatusBadge'
import { safeFormatDate } from '../../utils/dateUtils'
import type { ProjectJob } from '../../api/types'
import { parseJobGrounding, hasUsableCounts } from '../../api/jobGroundingSchema'

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

/**
 * Notice for a result the model could not see all the evidence for (issue #231).
 *
 * Two independent caps can bind, and they lose different things, so they are
 * reported separately rather than merged into one sentence:
 *
 * - **The context budget.** More was read than fits in one generation, so some
 *   records were trimmed before the model saw them. `feedback_items_used` and
 *   `feedback_count` describe this exactly.
 * - **The fetch limit.** More records matched the filters than the job reads at
 *   all. This one is invisible to the first: `context_truncated` compares what
 *   the model saw against what was READ, and everything the limit excluded was
 *   never read. Without saying so, "Based on 145 of 145 items" would present a
 *   ceiling as if it were the size of the corpus.
 *
 * Both wordings say "read" rather than implying the count is the whole corpus,
 * because neither number is the number of records the filters matched.
 *
 * Shown next to the completed job because that is where the user learns the
 * result exists.
 */
function TruncationNotice({ job }: { readonly job: ProjectJob }) {
  const { t } = useTranslation('projectDetail')
  const grounding = parseJobGrounding(job.result?.metadata)

  const trimmed = grounding.context_truncated === true
  const capped = grounding.fetch_limit_reached === true
  if (!trimmed && !capped) return null

  return (
    <>
      {trimmed && (
        <p className="text-xs text-amber-600 mt-1">
          {hasUsableCounts(grounding)
            ? t('jobs.truncated.counted', {
              used: grounding.feedback_items_used,
              total: grounding.feedback_count,
            })
            : t('jobs.truncated.generic')}
        </p>
      )}
      {capped && (
        <p className="text-xs text-amber-600 mt-1">
          {grounding.fetch_limit === undefined
            ? t('jobs.truncated.fetchCappedGeneric')
            : t('jobs.truncated.fetchCapped', { limit: grounding.fetch_limit })}
        </p>
      )}
    </>
  )
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
  // Moved above the completed-result branch, which used to come first. The two
  // are mutually exclusive by construction — hasCompletedResult requires
  // status === 'completed' and this requires status === 'failed' — so the order
  // between them cannot change what renders. Pinned by
  // 'a failed job with an artifact id shows the error, in either branch order'.
  if (job.status === 'failed' && job.error != null && job.error !== '') {
    return <p className="text-xs text-red-600 mt-1 truncate">{job.error}</p>
  }
  // The truncation notice is rendered for any completed job that reports it,
  // not only those with a named artifact: persona generation returns its
  // personas as a list rather than a single persona_id, so gating on
  // hasCompletedResult would hide the notice on the very surface it is for.
  return (
    <>
      {hasCompletedResult(job) && (
        <p className="text-xs text-gray-500 mt-1">
          {t('jobs.created')} {getCompletedLabel(job)}
        </p>
      )}
      <TruncationNotice job={job} />
    </>
  )
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
    generate_product_report: 'jobs.types.generateProductReport',
    build_prototype: 'jobs.types.buildPrototype',
    import_persona: 'jobs.types.importPersona',
    merge_documents: 'jobs.types.mergeDocuments',
  }[job.job_type] ?? 'jobs.types.research'

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

/**
 * `HH:mm` alone is ambiguous the moment a job outlives the day it started, and
 * completed jobs are kept until dismissed — so date the ones that aren't from
 * today. Routed through safeFormatDate because an unparseable created_at used to
 * throw "Invalid time value" out of the render.
 */
function formatJobTime(createdAt: string): string {
  const created = new Date(createdAt)
  const pattern = isValid(created) && !isToday(created) ? 'MMM d, HH:mm' : 'HH:mm'
  return safeFormatDate(created, pattern, '')
}

function JobItemActions({
  job, isStale, onDismiss,
}: JobItemProps) {
  const { t } = useTranslation('projectDetail')
  const showDismiss = job.status === 'completed' || job.status === 'failed' || isStale

  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      <span className="text-xs text-gray-400">
        {formatJobTime(job.created_at)}
      </span>
      {showDismiss ? <button
        onClick={() => onDismiss(job.job_id)}
        className="p-1 hover:bg-gray-200 rounded text-gray-400 hover:text-gray-600"
        title={t('jobs.dismiss')}
        aria-label={t('jobs.dismiss')}
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

/**
 * A group of jobs behind a single summary line. Owns its own expansion state:
 * nothing outside the group needs to know whether it is open.
 *
 * Used for completed jobs and for failures past the inline cap. The overflow has
 * to be expandable rather than a bare count, or those failures would be
 * unreachable until the visible ones were dismissed one by one.
 */
function CollapsibleJobGroup({
  jobs, label, icon, onDismiss,
}: JobsSectionProps & {
  readonly label: string
  readonly icon: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 rounded"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon}
        {label}
      </button>
      {expanded
        ? jobs.map((job) => (
          <JobItem key={job.job_id} job={job} isStale={false} onDismiss={onDismiss} />
        ))
        : null}
    </div>
  )
}

/**
 * Upper bound on the failed rows shown inline, so a project that accumulated
 * failures cannot push the tab content off the screen — the problem this panel's
 * resting state exists to solve.
 *
 * The cap applies to failures only. In-flight work is never capped: it is
 * inherently bounded by what a user can start, and a cap over the combined list
 * could hide a running job behind failed ones, which is why the original
 * unordered `slice(0, 5)` had to go rather than simply being kept.
 */
const MAX_VISIBLE_FAILED = 3

function isInFlight(job: ProjectJob): boolean {
  return job.status === 'running' || job.status === 'pending'
}

/**
 * Three groups: in-flight always inline, the first few failures inline, and the
 * rest — failures beyond the cap, and everything completed — behind their own
 * collapsible summaries. See the file header for why failures come first.
 */
function partitionByAttention(jobs: ProjectJob[]): {
  readonly inline: ProjectJob[]
  readonly overflowFailed: ProjectJob[]
  readonly completed: ProjectJob[]
} {
  const inFlight: ProjectJob[] = []
  const failed: ProjectJob[] = []
  const completed: ProjectJob[] = []
  for (const job of jobs) {
    if (job.status === 'completed') completed.push(job)
    else if (isInFlight(job)) inFlight.push(job)
    else failed.push(job)
  }
  return {
    inline: [...inFlight, ...failed.slice(0, MAX_VISIBLE_FAILED)],
    overflowFailed: failed.slice(MAX_VISIBLE_FAILED),
    completed,
  }
}

export default function JobsSection({
  jobs, onDismiss,
}: JobsSectionProps) {
  const { t } = useTranslation('projectDetail')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(interval)
  }, [])

  if (jobs.length === 0) return null

  const { inline, overflowFailed, completed } = partitionByAttention(jobs)

  return (
    <div className="bg-white rounded-xl p-6 border">
      <JobsSectionHeader />
      <div className="space-y-3">
        {inline.map((job) => (
          <JobItem
            key={job.job_id}
            job={job}
            isStale={checkIsStale(job.status, job.updated_at, now)}
            onDismiss={onDismiss}
          />
        ))}
        {overflowFailed.length > 0 ? (
          <CollapsibleJobGroup
            jobs={overflowFailed}
            label={t('jobs.moreFailedCount', { count: overflowFailed.length })}
            icon={<XCircle size={14} className="text-red-600" />}
            onDismiss={onDismiss}
          />
        ) : null}
        {completed.length > 0 ? (
          <CollapsibleJobGroup
            jobs={completed}
            label={t('jobs.completedCount', { count: completed.length })}
            icon={<CheckCircle size={14} className="text-green-600" />}
            onDismiss={onDismiss}
          />
        ) : null}
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
