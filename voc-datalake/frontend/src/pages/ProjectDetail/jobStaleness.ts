/**
 * @fileoverview When a project job reads as stale: still pending or running, with no progress written for
 * `STALE_THRESHOLD_MS`. One rule for the Background Jobs panel (JobsSection) and the Product tab's Extract
 * (useProductExtract), whose heartbeat writes progress every 30 s (shared/product_extract_model.py
 * `HEARTBEAT_SECONDS`), well inside it.
 *
 * @module pages/ProjectDetail/jobStaleness
 */
import type { ProjectJob } from '../../api/projectTypes'

/** No progress for this long: the job's worker is taken for gone (10 minutes). */
export const STALE_THRESHOLD_MS = 10 * 60 * 1000

/** A pending or running job whose last progress (`updated_at`) is older than `STALE_THRESHOLD_MS` at `now`; a job
 * with no `updated_at` is never stale. */
export function isStaleJob(job: Pick<ProjectJob, 'status' | 'updated_at'>, now: number): boolean {
  if (job.status !== 'running' && job.status !== 'pending') return false
  if (job.updated_at === undefined || job.updated_at === '') return false
  return new Date(job.updated_at).getTime() < now - STALE_THRESHOLD_MS
}
