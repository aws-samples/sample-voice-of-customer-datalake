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
 * @module api/assistJobs
 */
import { z } from 'zod'

export const ASSIST_POLL_INTERVAL_MS = 1500
export const ASSIST_TIMEOUT_MS = 15 * 60 * 1000

const GENERIC_FAILURE = 'The request failed. Please try again.'
const UNEXPECTED_ANSWER = 'Unexpected response from the server.'
const TIMED_OUT = 'The request is taking too long. Please try again later.'

const startAnswerSchema = z.object({
  job_id: z.string().min(1),
  status: z.string(),
})

// jscpd:ignore-start — mirrors lambda/stream/src/assistant/tools/server/assist-job.ts on purpose: separate packages, pinned by assistJobs.lockstep.test.ts
const pollAnswerSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  result: z.unknown().optional(),
  error: z.string().nullish(),
})
// jscpd:ignore-end of the accepted pair

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

function abortError(): Error {
  return new DOMException('The request was aborted.', 'AbortError')
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseAnswer<S extends z.ZodType>(schema: S, answer: unknown): z.output<S> {
  const parsed = schema.safeParse(answer)
  if (!parsed.success) throw new Error(UNEXPECTED_ANSWER)
  return parsed.data
}

/**
 * Start an assist job, poll it until it ends, and resolve `parse(result)`.
 *
 * Polls once straight after the start (the job read is consistent, and the mock
 * completes on the first poll), then every `intervalMs`. Rejects with the job's
 * `error` when it fails, with a timeout error past `timeoutMs`, and with an
 * `AbortError` when `signal` aborts. A start or poll answer that is not the
 * contract's shape is an error, never a cast.
 */
export async function runAssistJob<T>(
  start: () => Promise<unknown>,
  poll: (jobId: string) => Promise<unknown>,
  parse: (result: unknown) => T,
  opts: AssistJobOptions = {},
): Promise<T> {
  const { intervalMs = ASSIST_POLL_INTERVAL_MS, timeoutMs = ASSIST_TIMEOUT_MS, signal } = opts
  const deadline = Date.now() + timeoutMs
  const { job_id: jobId } = parseAnswer(startAnswerSchema, await start())
  for (;;) {
    if (signal?.aborted === true) throw abortError()
    const answer = parseAnswer(pollAnswerSchema, await poll(jobId))
    if (answer.status === 'completed') return parse(answer.result)
    if (answer.status === 'failed') {
      throw new Error(answer.error != null && answer.error !== '' ? answer.error : GENERIC_FAILURE)
    }
    if (Date.now() + intervalMs > deadline) throw new Error(TIMED_OUT)
    await sleep(intervalMs, signal)
  }
}
