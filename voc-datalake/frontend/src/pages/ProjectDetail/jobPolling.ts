/**
 * Shared resilient job polling for async project jobs (prototype builds,
 * product reports, document generation).
 *
 * Kicked-off jobs are polled via projectsApi.getJobStatus until they reach
 * `completed` or `failed`, or the deadline passes. A single Wi-Fi hiccup or a
 * brief CloudFront edge glitch shouldn't kill the whole flow with "Failed to
 * fetch", so up to `maxConsecutiveErrors` transient poll failures are
 * tolerated before giving up — at the default cadence that's >15 seconds of
 * network trouble, by which point something is genuinely wrong.
 *
 * Extracted from the three copies that previously lived in
 * BuildPrototypeButton, DocumentsTab's revision form, and ProductTab's
 * ReportCard.
 */
import { projectsApi } from '../../api/projectsApi'
import type { ProjectJob } from '../../api/types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface PollJobOptions {
  /** Total time budget before giving up (default 5 minutes). */
  readonly timeoutMs?: number
  /** Delay between polls (default 3 seconds). */
  readonly intervalMs?: number
  /** Consecutive transient poll errors tolerated before rethrowing (default 5). */
  readonly maxConsecutiveErrors?: number
}

export type PollJobResult =
  | { status: 'completed'; job: ProjectJob }
  | { status: 'failed'; job: ProjectJob }
  | { status: 'timeout' }

/**
 * Poll a project job to a terminal state. Returns the outcome instead of
 * throwing on failure/timeout so callers keep control of their user-facing
 * error messages. Transient network errors during polling are retried up to
 * `maxConsecutiveErrors` times (with the normal poll delay between attempts),
 * then rethrown. The error count resets on every successful poll, matching
 * the original inline implementations.
 */
export async function pollJobToCompletion(
  projectId: string,
  jobId: string,
  options: PollJobOptions = {},
): Promise<PollJobResult> {
  const { timeoutMs = 5 * 60_000, intervalMs = 3000, maxConsecutiveErrors = 5 } = options
  const deadline = Date.now() + timeoutMs

  const fetchWithTolerance = async (consecutiveErrors = 0): Promise<ProjectJob> => {
    try {
      return await projectsApi.getJobStatus(projectId, jobId)
    } catch (pollErr) {
      const attempt = consecutiveErrors + 1
      if (attempt >= maxConsecutiveErrors) throw pollErr
      console.warn(`Job poll error ${attempt}/${maxConsecutiveErrors} — retrying`, pollErr)
      await sleep(intervalMs)
      return fetchWithTolerance(attempt)
    }
  }

  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const job = await fetchWithTolerance()
    if (job.status === 'completed') return { status: 'completed', job }
    if (job.status === 'failed') return { status: 'failed', job }
  }
  return { status: 'timeout' }
}
