/**
 * When a background job's output should be refetched: a job that completed in the
 * last ten seconds. Shared by the project page and the company persona library, which
 * both refresh their personas when a generate / import job finishes.
 */
import type { ProjectJob } from '../../api/projectTypes'

const RECENT_COMPLETION_MS = 10_000

export function hasRecentlyCompletedJob(jobs: ReadonlyArray<Pick<ProjectJob, 'status' | 'completed_at'>>, now: number): boolean {
  return jobs.some((job) =>
    job.status === 'completed' && job.completed_at != null && job.completed_at !== ''
    && new Date(job.completed_at).getTime() > now - RECENT_COMPLETION_MS)
}
