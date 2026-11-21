/**
 * @fileoverview The AI draft as an assist job (part A, docs/feedback-forms.md "AI drafts"): `POST /feedback-forms/draft`
 * answers 202 `{job_id, status}`, and the browser reads `GET /feedback-forms/draft/{job_id}` (its own jobs only) until
 * the job ends: `{status: 'completed', result: {success: true, form, notes, warnings}}`, or a result that refuses
 * (`{success: false, code: 'invalid_draft' | 'no_model', error, errors?}`), or `status: 'failed'` with its `error`.
 * A server that answers the draft at once (`{form, notes, warnings}`, the dev mock) needs no poll.
 *
 * Push (TENETS.md tenet 7, docs/realtime.md): when the job ends, the settings assist worker that ran it sends the
 * starter a `job` notice on their own channel (lambda/shared/assist_jobs.py `_notify`). While the page is subscribed,
 * that notice wakes the loop at once and the poll slows to the subscribed fallback ({@link
 * ASSIST_SUBSCRIBED_POLL_INTERVAL_MS}, for a lost notice); a (re)connect reads at once. Not subscribed (the dev mock,
 * an older deployment): a read every 1.5 s, as before. Stop drafting aborts the loop (`signal`).
 *
 * @module api/feedbackFormsDraftJob
 */
import { z } from 'zod'
import { ASSIST_SUBSCRIBED_POLL_INTERVAL_MS } from './assistJobs'
import { isRealtimeLive, watchRealtime } from '../realtime/hub'

const POLL_MS = 1500
/** A draft that hasn't ended this long after its start is given up (the model's budget is far shorter). */
const MAX_WAIT_MS = 3 * 60 * 1000

const started = z.object({ job_id: z.string().min(1) })
const job = z.object({
  status: z.string().catch(''),
  result: z.unknown().optional(),
  error: z.string().nullable().optional().catch(undefined),
})
const refused = z.object({
  success: z.literal(false),
  code: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  errors: z.array(z.unknown()).optional().catch(undefined),
})

/** How a refusal becomes the caller's error (the forms API's FormsApiError): status, code, message, errors. */
export type DraftRefusal = (status: number, code: string | undefined, message: string | undefined, errors: readonly unknown[]) => Error

/** The status a job's refusal reads as: 422 for a draft the validator refused twice, 503 for no model. */
const STATUS_OF: Readonly<Record<string, number>> = { invalid_draft: 422, no_model: 503 }

/** A job's result: the draft, or the refusal it ended with. */
function resultOf(result: unknown, refuse: DraftRefusal): unknown {
  const no = refused.safeParse(result)
  if (!no.success) return result
  const code = no.data.code
  throw refuse(code === undefined ? 500 : STATUS_OF[code] ?? 500, code, no.data.error, no.data.errors ?? [])
}

/**
 * How long to wait before the next read: 1.5 s, or the subscribed fallback while push is live (the job's notice is
 * expected), never past the deadline. Null once the deadline has passed.
 */
function nextPause(deadline: number): number | null {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return null
  return Math.min(isRealtimeLive() ? Math.max(POLL_MS, ASSIST_SUBSCRIBED_POLL_INTERVAL_MS) : POLL_MS, remaining)
}

/**
 * The draft a POST answered: at once, or once its job ends (read after each pause, or at once on the job's notice;
 * cancelled with `signal`, an AbortError). Past three minutes it is a 504 `timeout`.
 */
export async function settleDraft(answer: unknown, poll: (jobId: string) => Promise<unknown>, refuse: DraftRefusal,
  signal?: AbortSignal): Promise<unknown> {
  const start = started.safeParse(answer)
  if (!start.success) return answer
  const jobId = start.data.job_id
  const deadline = Date.now() + MAX_WAIT_MS
  const watch = watchRealtime((notice) => notice.type === 'job' && notice.job_id === jobId)
  try {
    for (;;) {
      const pause = nextPause(deadline)
      if (pause === null) throw refuse(504, 'timeout', undefined, [])
      await watch.wait(pause, signal)
      const state = job.parse(await poll(jobId))
      if (state.status === 'completed') return resultOf(state.result, refuse)
      if (state.status === 'failed') throw refuse(500, undefined, state.error ?? undefined, [])
    }
  } finally {
    watch.close()
  }
}
