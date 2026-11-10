/**
 * Follows a project job to a terminal state through the real API
 * (`GET /projects/{id}/jobs/{job_id}`), recording every poll, and derives the
 * timings the brief asks for: queue-to-start (created_at -> first poll that is
 * no longer `pending`) and total (created_at -> completed_at).
 */
import { apiCall } from './api'
import { isRecord } from './guards'
import type { Role } from './env'

export interface JobPoll {
  at: string
  status: number
  ms: number
  jobStatus: string
  progress: number | null
  currentStep: string
}

export interface JobTrace {
  jobId: string
  jobType: string
  finalStatus: string
  error: string | null
  createdAt: string | null
  completedAt: string | null
  /** created_at -> first poll that saw running/completed/failed (upper bound, poll-resolution). */
  queueToStartMs: number | null
  /** created_at -> completed_at (server clock). */
  totalMs: number | null
  polls: JobPoll[]
  result: unknown
}

const TERMINAL = new Set(['completed', 'failed'])
const POLL_MS = 5_000

/**
 * HTTP answers that never change by polling again: an expired session (401), no access (403),
 * and a job or project that is gone (404 / 410: the project was deleted mid-job, or the job id is
 * unknown or expired). Each further poll would only add a deliberate 4xx to the logs.
 */
const FINAL_HTTP = new Set([401, 403, 404, 410])

/** Pure: does this poll end the follow (a final HTTP answer, or a terminal job status)? */
export function pollEnds(httpStatus: number, jobStatus: string): boolean {
  return FINAL_HTTP.has(httpStatus) || TERMINAL.has(jobStatus)
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value : ''
}

const epoch = (iso: string | null): number | null => {
  if (iso === null || iso === '') return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

export async function followJob(role: Role, projectId: string, jobId: string, timeoutMs: number): Promise<JobTrace> {
  const polls: JobPoll[] = []
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> = {}
  let firstStartedAt: number | null = null
  for (;;) {
    const res = await apiCall(role, 'GET', `/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`)
    const body = isRecord(res.body) ? res.body : {}
    const jobStatus = str(body, 'status')
    const progress = typeof body['progress'] === 'number' ? body['progress'] : null
    polls.push({ at: new Date().toISOString(), status: res.status, ms: res.ms, jobStatus, progress, currentStep: str(body, 'current_step') })
    if (res.status === 200) last = body
    if (firstStartedAt === null && res.status === 200 && jobStatus !== '' && jobStatus !== 'pending') firstStartedAt = Date.now()
    // Fail fast on an answer polling cannot change (FINAL_HTTP) instead of spinning to the deadline.
    if (pollEnds(res.status, jobStatus) || Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return summarizeJob(jobId, last, firstStartedAt, polls)
}

/** Pure: the trace for the last 200 body seen (exported for reuse by specs that poll themselves). */
export function summarizeJob(jobId: string, last: Record<string, unknown>, firstStartedAt: number | null, polls: JobPoll[]): JobTrace {
  const createdAt = str(last, 'created_at') || null
  const completedAt = str(last, 'completed_at') || null
  const created = epoch(createdAt)
  const completed = epoch(completedAt)
  return {
    jobId,
    jobType: str(last, 'job_type'),
    finalStatus: str(last, 'status') || 'unknown',
    error: str(last, 'error') || null,
    createdAt,
    completedAt,
    queueToStartMs: created !== null && firstStartedAt !== null ? Math.max(0, firstStartedAt - created) : null,
    totalMs: created !== null && completed !== null ? completed - created : null,
    polls,
    result: last['result'] ?? null,
  }
}

/** The job ids in `GET /projects/{id}/jobs` (newest first) that are not in `known`. */
export async function newJobIds(role: Role, projectId: string, known: ReadonlySet<string>): Promise<Array<{ jobId: string; jobType: string }>> {
  const res = await apiCall(role, 'GET', `/projects/${encodeURIComponent(projectId)}/jobs`)
  const jobs = isRecord(res.body) && Array.isArray(res.body['jobs']) ? res.body['jobs'].filter(isRecord) : []
  return jobs
    .map((j) => ({ jobId: str(j, 'job_id'), jobType: str(j, 'job_type') }))
    .filter((j) => j.jobId !== '' && !known.has(j.jobId))
}
