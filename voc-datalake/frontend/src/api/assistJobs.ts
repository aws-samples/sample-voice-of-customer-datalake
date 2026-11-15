/**
 * @fileoverview Start-and-poll for the API's assist jobs.
 *
 * A model call that can outlast API Gateway's 29-second integration limit runs
 * as an "assist job": the route answers **202** `{success, job_id, status}` at
 * once and a worker does the work; the caller polls a job read until the job is
 * `completed` (its `result` is exactly the body the route used to return) or
 * `failed` (its `error` is the message the route used to answer). See
 * `lambda/shared/assist_jobs.py`.
 *
 * Every API function that moved to a job keeps its name, arguments and resolved
 * type by passing its own start, poll and result parser through here, so the
 * components and their mutations did not change.
 *
 * Push (docs/realtime.md): while the page is subscribed to its notices, the worker's
 * `job` notice for this job wakes the loop at once, and the poll slows to
 * {@link ASSIST_SUBSCRIBED_POLL_INTERVAL_MS} as the fallback for a lost notice; a
 * (re)connect polls at once. Not subscribed (the dev mock, an older deployment): the
 * same 1.5 s polling as before.
 *
 * @module api/assistJobs
 */
import { z } from 'zod'
import { assistJobPollSchema } from '@stream/assistant/tools/server/assist-job-values'
import { isRealtimeLive, watchRealtime } from '../realtime/hub'
import { abortError } from '../lib/abortError'

export const ASSIST_POLL_INTERVAL_MS = 1500
export const ASSIST_TIMEOUT_MS = 15 * 60 * 1000
/** The fallback poll while the job's notice is expected (push is live). */
export const ASSIST_SUBSCRIBED_POLL_INTERVAL_MS = 10_000

const GENERIC_FAILURE = 'The request failed. Please try again.'
const UNEXPECTED_ANSWER = 'Unexpected response from the server.'
const TIMED_OUT = 'The request is taking too long. Please try again later.'

const startAnswerSchema = z.object({
  job_id: z.string().min(1),
  status: z.string(),
})

export interface AssistJobOptions {
  /** Pause between two polls (default 1.5 s). */
  readonly intervalMs?: number
  /** Give up this long after the start (default 15 minutes, the worker's own limit). */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** True for the job types the project Background jobs panel never lists. */
export function isAssistJobType(jobType: unknown): boolean {
  return typeof jobType === 'string' && jobType.startsWith('assist_')
}

function parseAnswer<S extends z.ZodType>(schema: S, answer: unknown): z.output<S> {
  const parsed = schema.safeParse(answer)
  if (!parsed.success) throw new Error(UNEXPECTED_ANSWER)
  return parsed.data
}

/**
 * How long to wait before the next poll: `intervalMs`, or the slower fallback while the job's notice is
 * expected (push is live), never past the deadline. Throws the timeout when not even `intervalMs` is left.
 */
function nextPause(intervalMs: number, deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining < intervalMs) throw new Error(TIMED_OUT)
  const pause = isRealtimeLive() ? Math.max(intervalMs, ASSIST_SUBSCRIBED_POLL_INTERVAL_MS) : intervalMs
  return Math.min(pause, remaining)
}

/**
 * Start an assist job, poll it until it ends, and resolve `parse(result, jobId)` (the job id for a
 * result that names its pass, e.g. Revise from comments' save of its proposal).
 *
 * Polls once straight after the start (the job read is consistent, and the mock
 * completes on the first poll), then every `intervalMs`, or on the job's notice
 * (at most {@link ASSIST_SUBSCRIBED_POLL_INTERVAL_MS} apart) while push is live. Rejects with the job's
 * `error` when it fails, with a timeout error past `timeoutMs`, and with an
 * `AbortError` when `signal` aborts. A start or poll answer that is not the
 * contract's shape is an error, never a cast.
 */
export async function runAssistJob<T>(
  start: () => Promise<unknown>,
  poll: (jobId: string) => Promise<unknown>,
  parse: (result: unknown, jobId: string) => T,
  opts: AssistJobOptions = {},
): Promise<T> {
  const { intervalMs = ASSIST_POLL_INTERVAL_MS, timeoutMs = ASSIST_TIMEOUT_MS, signal } = opts
  const deadline = Date.now() + timeoutMs
  const { job_id: jobId } = parseAnswer(startAnswerSchema, await start())
  const watch = watchRealtime((notice) => notice.type === 'job' && notice.job_id === jobId)
  try {
    for (;;) {
      if (signal?.aborted === true) throw abortError()
      const answer = parseAnswer(assistJobPollSchema, await poll(jobId))
      if (answer.status === 'completed') return parse(answer.result, jobId)
      if (answer.status === 'failed') {
        throw new Error(answer.error != null && answer.error !== '' ? answer.error : GENERIC_FAILURE)
      }
      await watch.wait(nextPause(intervalMs, deadline), signal)
    }
  } finally {
    watch.close()
  }
}
