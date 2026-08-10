/**
 * Shared readers for the `history` payload a chat surface sends.
 *
 * Three test files assert on the same contract — the `Array<{role, content}>`
 * that `buildHistory` returns — so the guard that validates it lives once here
 * rather than being copied per file, where the copies would drift.
 *
 * Deliberately validated with a type guard rather than an `as` cast: a change
 * to the payload shape should fail *here*, with a message naming what was
 * wrong, instead of being asserted away and surfacing as a confusing failure
 * further down the test.
 */

/** A history entry as read back off a mocked send call. */
export interface SentHistoryEntry {
  role: string
  content: string
}

export function isHistoryEntry(value: unknown): value is SentHistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const record: Record<string, unknown> = { ...value }
  return typeof record.role === 'string' && typeof record.content === 'string'
}

/** The shape of a `vi.fn()` this module needs, without depending on Vitest's Mock type. */
interface CallRecorder {
  mock: { calls: unknown[][] }
}

/**
 * Read the `history` array from a recorded call on a mocked send function.
 *
 * @param recorder The mock that received the call.
 * @param callIndex Which call to read, 0-based.
 * @param argIndex Which argument carries the `history` field — the options
 *   object for `sendMessage`, the request body for the interview endpoint.
 */
export function readSentHistory(
  recorder: CallRecorder,
  callIndex = 0,
  argIndex = 1,
): SentHistoryEntry[] {
  const call: unknown[] | undefined = recorder.mock.calls[callIndex]
  if (call === undefined) throw new Error(`send was not called ${callIndex + 1} time(s)`)
  const carrier: unknown = call[argIndex]
  if (typeof carrier !== 'object' || carrier === null || !('history' in carrier)) {
    throw new Error(`argument ${argIndex} of the call did not include a history field`)
  }
  const { history } = carrier
  if (!Array.isArray(history) || !history.every(isHistoryEntry)) {
    throw new Error('history was not an array of {role, content} entries')
  }
  return history
}

/**
 * True when two adjacent entries share a role — the shape Bedrock Converse
 * rejects with a turn-alternation `ValidationException`.
 */
export function hasAdjacentSameRole(history: readonly SentHistoryEntry[]): boolean {
  return history.some((entry, i) => i > 0 && entry.role === history[i - 1].role)
}
