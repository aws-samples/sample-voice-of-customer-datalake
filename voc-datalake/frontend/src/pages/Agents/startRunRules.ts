/**
 * @fileoverview The rules of a run's start, as the server checks them (`lambda/api/agents_handler.py`
 * `_start_body`; held to it by this module's lockstep test): a connection's short id, a full commit id of 40
 * hexadecimal characters, a language with an agent image, and a goal on one line of at most {@link MAX_RUN_GOAL}
 * characters. The form says what is wrong before anything is sent; the server checks again.
 *
 * @module pages/Agents/startRunRules
 */
import { ApiError, AuthError, ConfigError, serverReason } from '../../lib/errors'
import type { StartRunRequest } from '../../api/engineeringRunsApi'

/** The languages with an agent image (engineering-images/, `runtime/egress.py` REGISTRY_HOSTS). */
export const RUN_LANGUAGES = ['java', 'node', 'python', 'rust'] as const
export type RunLanguage = (typeof RUN_LANGUAGES)[number]
/** The longest goal (agents_handler.py MAX_RUN_GOAL): longer is refused, never cut. */
export const MAX_RUN_GOAL = 500
/** A connection id's longest (runtime/interface.py MAX_ID_LENGTH). */
export const MAX_CONNECTION_ID = 63
const CONNECTION = new RegExp(`^[A-Za-z0-9-]{1,${String(MAX_CONNECTION_ID)}}$`)
const COMMIT = /^[0-9a-f]{40}$/

export interface StartRunForm {
  connection: string
  commit: string
  language: RunLanguage
  goal: string
}

/** What is wrong with a field, as its message key under `startRun.invalid`. */
type StartRunIssue = 'connection' | 'commit' | 'goalEmpty' | 'goalLong'
export type StartRunIssues = Partial<Record<'connection' | 'commit' | 'goal', StartRunIssue>>

/** The goal as it is sent: on one line, its spaces collapsed. */
const oneLine = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ')

/** A text's length as the server counts it (Python's `len`: code points, a surrogate pair counted once). */
const codePoints = (text: string): number => text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '_').length

/** What is wrong with the form, field by field (empty when it can be sent). */
export function startRunIssues(form: StartRunForm): StartRunIssues {
  const issues: StartRunIssues = {}
  if (!CONNECTION.test(form.connection.trim())) issues.connection = 'connection'
  if (!COMMIT.test(form.commit.trim().toLowerCase())) issues.commit = 'commit'
  const goal = oneLine(form.goal)
  if (goal === '') issues.goal = 'goalEmpty'
  else if (codePoints(goal) > MAX_RUN_GOAL) issues.goal = 'goalLong'
  return issues
}

/** A run id as the server mints it (a ULID), where its 503 names the run: "run <id> may have been started …". */
const NAMED_RUN = /\brun ([0-9A-HJKMNP-TV-Z]{26})\b/

/** What a failed start may have done: written a run it names (open it), or something nobody can tell (check). */
export type StartOutcome = { kind: 'named'; runId: string } | { kind: 'unknown' }

/**
 * What a failed start leaves, once the request was sent: never "start it again" unless the server said nothing was
 * written.
 * - A run the answer names (`run_id` in its body, else "run <id>" in a 503's message): it was written, or may have been.
 * - A 504, a 5xx with no reason of the server's own (a gateway's page, not JSON), a network failure, or an answer that
 *   is not one (not JSON, or no run in it): it may have started, and nobody can tell which run.
 * - Null: the server's own answer, which says what to do (a refusal, a bad field, "start it again"); or a sign-in that
 *   ended (nothing was started).
 */
export function startOutcomeOf(error: unknown): StartOutcome | null {
  if (error instanceof AuthError || error instanceof ConfigError) return null
  if (!(error instanceof ApiError)) return { kind: 'unknown' }   // (a network failure, an answer that is not one)
  const named = error.runId ?? (error.status === 503 ? NAMED_RUN.exec(error.message)?.[1] : undefined)
  if (named !== undefined) return { kind: 'named', runId: named }
  if (error.status === 504 || (error.status >= 500 && serverReason(error) === null)) return { kind: 'unknown' }
  return null
}

/** The request for a form with no issues: trimmed, the commit in lower case, the goal on one line. */
export function startRunRequest(workflowId: string, form: StartRunForm): StartRunRequest {
  return {
    workflow_id: workflowId, connection: form.connection.trim(), commit: form.commit.trim().toLowerCase(),
    language: form.language, goal: oneLine(form.goal),
  }
}
