/**
 * @fileoverview Background jobs as one compact badge in the project header
 * ("2 running", "1 failed", "3 done") that opens the jobs panel, instead of a
 * block above the content on every tab. Nothing when the project has no jobs.
 *
 * The panel is `JobsSection` (unchanged: in-flight and failed jobs inline,
 * completed behind a summary). Escape or a click outside closes it.
 *
 * @module pages/ProjectDetail/JobsBadge
 */
import clsx from 'clsx'
import { CheckCircle, Loader2, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDisclosurePopover } from '../../hooks/useDismissOnOutside'
import JobsSection from './JobsSection'
import type { ProjectJob } from '../../api/projectTypes'

interface JobCounts {
  readonly running: number
  readonly failed: number
  readonly done: number
}

function countJobs(jobs: readonly ProjectJob[]): JobCounts {
  const running = jobs.filter((j) => j.status === 'running' || j.status === 'pending').length
  const failed = jobs.filter((j) => j.status === 'failed').length
  return { running, failed, done: jobs.length - running - failed }
}

/** What the badge says first: running work, else failures, else what finished. */
function BadgeLabel({ counts }: Readonly<{ counts: JobCounts }>) {
  const { t } = useTranslation('projectDetail')
  if (counts.running > 0) return <><Loader2 size={14} className="animate-spin" aria-hidden />{t('jobs.badge.running', { count: counts.running })}</>
  if (counts.failed > 0) return <><XCircle size={14} aria-hidden />{t('jobs.badge.failed', { count: counts.failed })}</>
  return <><CheckCircle size={14} aria-hidden />{t('jobs.badge.done', { count: counts.done })}</>
}

export default function JobsBadge({ jobs, onDismiss }: Readonly<{
  jobs: ProjectJob[]
  onDismiss?: (jobId: string) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const { open, toggle, panelId, wrapper, trigger } = useDisclosurePopover()
  if (jobs.length === 0) return null
  const counts = countJobs(jobs)
  const tone = counts.running === 0 && counts.failed > 0 ? 'text-danger border-danger/40' : 'text-text'
  return (
    <div className="relative flex-shrink-0" ref={wrapper}>
      <button ref={trigger} type="button" onClick={toggle} aria-expanded={open}
        aria-controls={open ? panelId : undefined} title={t('jobs.backgroundJobs')}
        className={clsx('btn btn-secondary', tone)}>
        <BadgeLabel counts={counts} />
        <span className="sr-only"> — {t('jobs.backgroundJobs')}</span>
      </button>
      {open && (
        <div id={panelId} role="region" aria-label={t('jobs.backgroundJobs')}
          className="absolute right-0 top-full mt-2 z-30 w-[min(32rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto shadow-lg rounded-xl">
          <JobsSection jobs={jobs} onDismiss={onDismiss} />
        </div>
      )}
    </div>
  )
}
