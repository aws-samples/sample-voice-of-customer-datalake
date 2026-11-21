/**
 * @fileoverview Why an AI draft did not come back (UX §12.4), from the error `POST /feedback-forms/draft` answered:
 *
 * | Answer | Case |
 * |---|---|
 * | 403 `role` | only editors and administrators may draft |
 * | 403 `ai_mode` | the person's way of working keeps AI from writing (Human-driven) |
 * | 403 / 503 `no_model` | no AI model is available to this workspace |
 * | 429 `spend_cap` | the workspace's AI budget for the month is used up |
 * | 429 (`rate_limited`) | the AI limit for now; `retry_after` seconds |
 * | 422 | the AI's form stayed invalid after its repair; the validator's errors |
 * | 5xx, a timeout, no answer | the AI didn't answer |
 * | anything else | the server's own message |
 *
 * @module pages/FeedbackForms/ai/aiRefusal
 */
import { ApiError } from '../../../lib/errors'
import { FormsApiError } from '../../../api/feedbackFormsV2Api'

export type AiRefusal =
  | { readonly kind: 'role' }
  | { readonly kind: 'aiMode' }
  | { readonly kind: 'noModel' }
  | { readonly kind: 'spendCap' }
  /** `until`: when Draft it may be pressed again (ms since the epoch). */
  | { readonly kind: 'rateLimited'; readonly until: number }
  | { readonly kind: 'invalid'; readonly errors: readonly string[] }
  | { readonly kind: 'noAnswer' }
  | { readonly kind: 'other'; readonly message: string }

const FORBIDDEN = 403
const INVALID = 422
const TOO_MANY = 429
const UNAVAILABLE = 503
const SERVER_ERROR = 500
const DEFAULT_WAIT_SECONDS = 60

function forbidden(code: string | undefined, message: string): AiRefusal {
  if (code === 'ai_mode') return { kind: 'aiMode' }
  if (code === 'no_model') return { kind: 'noModel' }
  if (code === 'role') return { kind: 'role' }
  return { kind: 'other', message }
}

function limited(error: ApiError, now: number): AiRefusal {
  if (error.code === 'spend_cap') return { kind: 'spendCap' }
  const seconds = error instanceof FormsApiError ? error.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS : DEFAULT_WAIT_SECONDS
  return { kind: 'rateLimited', until: now + seconds * 1000 }
}

/** The §12.4 case of a failed draft request; `now` dates a rate limit's end. */
export function aiRefusalOf(error: unknown, now: number = Date.now()): AiRefusal {
  if (!(error instanceof ApiError)) return { kind: 'noAnswer' }
  const { status, code, message } = error
  if (status === FORBIDDEN) return forbidden(code, message)
  if (status === UNAVAILABLE && code === 'no_model') return { kind: 'noModel' }
  if (status === TOO_MANY) return limited(error, now)
  if (status === INVALID) {
    return { kind: 'invalid', errors: error instanceof FormsApiError ? error.errors.map((entry) => entry.message) : [] }
  }
  if (status >= SERVER_ERROR) return { kind: 'noAnswer' }
  return { kind: 'other', message }
}

/** Is the error the request's own cancel (the person pressed Cancel, or started another)? */
export function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
}
