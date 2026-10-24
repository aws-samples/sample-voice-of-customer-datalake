/**
 * Waiting on an assist job (lambda/shared/assist_jobs.py) from inside a tool.
 *
 * A converted model-backed route answers its start with HTTP 202
 * `{success, job_id, status: 'pending'}`; the work runs in the API Lambda's
 * worker twin, and a poll route answers `{status, result, error, ...}` where
 * `result` is exactly the body the route used to answer synchronously.
 *
 * `awaitAssistJob` polls every `ASSIST_POLL_INTERVAL_MS` until the job is
 * `completed` (resolves `result`) or `failed` (throws with the job's `error`),
 * and gives up before the running Lambda invocation is cut off — or after
 * `ASSIST_POLL_CAP_MS` when the deadline is unknown — so the run can still
 * answer the model and save its session.
 */
import { z } from 'zod';
import { AssistantToolError } from '../errors.js';
import { clip } from '../format.js';

export const ASSIST_POLL_INTERVAL_MS = 1500;
/** Upper bound on one wait, whatever the deadline. */
export const ASSIST_POLL_CAP_MS = 10 * 60_000;
/** Time kept back before the invocation deadline: the model's answer and the final session save. */
export const ASSIST_DEADLINE_MARGIN_MS = 60_000;
const MAX_ERROR_CHARS = 200;

const startSchema = z.object({ job_id: z.string().min(1).max(128) });

// jscpd:ignore-start — mirrors frontend/src/api/assistJobs.ts on purpose: separate packages, pinned by assistJobs.lockstep.test.ts
const pollSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  result: z.unknown().optional(),
  error: z.string().nullish(),
});
// jscpd:ignore-end of the accepted pair

export interface AssistJobClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export interface AssistJobWait {
  /** The start route's 2xx body. */
  started: unknown;
  /** Read the job once (the poll route's 2xx body). */
  poll(jobId: string): Promise<unknown>;
  /** Epoch ms the invocation is cut off, when known. */
  deadlineMs?: number;
  /** Names the work in error text, e.g. "The page analysis". */
  label: string;
}

/** The instant past which no further poll starts. */
function giveUpAt(clock: AssistJobClock, deadlineMs: number | undefined): number {
  const cap = clock.nowMs() + ASSIST_POLL_CAP_MS;
  return deadlineMs === undefined ? cap : Math.min(cap, deadlineMs - ASSIST_DEADLINE_MARGIN_MS);
}

function unexpected(label: string): AssistantToolError {
  return new AssistantToolError('unavailable', `${label} answered unexpectedly. Try again later.`);
}

export async function awaitAssistJob(clock: AssistJobClock, wait: AssistJobWait): Promise<unknown> {
  const start = startSchema.safeParse(wait.started);
  if (!start.success) throw unexpected(wait.label);
  const jobId = start.data.job_id;
  const stopAt = giveUpAt(clock, wait.deadlineMs);
  for (;;) {
    // The first poll waits too: the worker has only just been invoked.
    if (clock.nowMs() + ASSIST_POLL_INTERVAL_MS > stopAt) {
      throw new AssistantToolError('unavailable', `${wait.label} is taking too long and was not waited for. Try again later.`);
    }
    await clock.sleep(ASSIST_POLL_INTERVAL_MS);
    const job = pollSchema.safeParse(await wait.poll(jobId));
    if (!job.success) throw unexpected(wait.label);
    if (job.data.status === 'completed') return job.data.result;
    if (job.data.status === 'failed') {
      const reason = job.data.error ? `: ${clip(job.data.error, MAX_ERROR_CHARS)}` : '.';
      throw new AssistantToolError('unavailable', `${wait.label} failed${reason}`);
    }
  }
}
