/**
 * When a background job's output should be refetched: a job that completed in the
 * last ten seconds. Shared by the project page and the company persona library, which
 * both refresh their personas when a generate / import job finishes.
 */
import type { ProjectJob } from '../../api/projectTypes'

const RECENT_COMPLETION_MS = 10_000

type CompletionFields = Pick<ProjectJob, 'status' | 'completed_at'>

function completedRecently(job: CompletionFields, now: number): boolean {
  return job.status === 'completed' && job.completed_at != null && job.completed_at !== ''
    && new Date(job.completed_at).getTime() > now - RECENT_COMPLETION_MS
}

/** The jobs that completed in the last ten seconds (an older one dropping out of the list never counts). */
export function recentlyCompletedJobs<T extends CompletionFields>(jobs: ReadonlyArray<T>, now: number): T[] {
  return jobs.filter((job) => completedRecently(job, now))
}

export function hasRecentlyCompletedJob(jobs: ReadonlyArray<CompletionFields>, now: number): boolean {
  return jobs.some((job) => completedRecently(job, now))
}
