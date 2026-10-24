/**
 * @fileoverview The error text an approval reports back to the model.
 *
 * It goes into a `tool` message, so it must not carry response bodies, stack
 * traces or document text — only a status-derived sentence the model can relay.
 * 403 is "no permission" (per-project roles), never a crash.
 *
 * @module assistant/approvals/safeError
 */
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { StaleApprovalError } from './shown'

const SESSION_EXPIRED = 'Session expired. Please login again.'

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was rejected as invalid.',
  401: 'You are not signed in.',
  403: "You don't have permission to do this.",
  404: 'The item was not found — it may have been deleted.',
  409: 'The change conflicts with the current state; reload and try again.',
  413: 'The request was too large.',
  429: 'Too many requests; please try again shortly.',
}

export function safeErrorMessage(error: unknown): string {
  const status = apiErrorStatus(error)
  if (status !== null) {
    return STATUS_MESSAGES[status] ?? `The request failed (HTTP ${status}).`
  }
  if (error instanceof Error && error.message === SESSION_EXPIRED) return SESSION_EXPIRED
  // Our own fixed sentence (no server or document text): safe to relay.
  if (error instanceof StaleApprovalError) return error.message
  return 'The action failed before the server answered.'
}
