/**
 * @fileoverview The `context` string sent alongside a VoC chat message.
 *
 * Extracted from Chat.tsx so its LENGTH can be pinned by a test. The stream
 * schema caps `context` at 500 chars and — unlike `message` — rejects rather than
 * clamps, on the stated grounds that this string is code-authored and bounded by
 * construction. That reasoning is only as good as the bound, and nothing enforced
 * it: a multi-select added to ChatFilters would turn the cap into an untranslated
 * 400. `chatContext.test.ts` asserts the worst case, so the invariant the schema's
 * policy rests on now fails loudly if it stops holding.
 *
 * (Also: a non-component export from a .tsx trips
 * `react-refresh/only-export-components`, which the lint gate treats as an error.)
 *
 * @module pages/Chat/chatContext
 */
import type { ChatFilters } from '../../store/chatStore'

/**
 * Per-value bound, which is what makes the total provable rather than assumed.
 *
 * Filter values are NOT all code-bounded: `category` comes from the tenant's
 * configured category list and `settings_handler.py` validates its length nowhere,
 * so a 450-char configured category would otherwise push `context` past the
 * server's 500 and produce an untranslated 400.
 *
 * Worst case with this bound: 25 (time range) + 130 + 132 + 133 = 420 < 500, and
 * `chatContext.test.ts` asserts it against a pathologically long value. 120 is far
 * above any real category, source or sentiment, so realistic values are untouched.
 */
export const MAX_FILTER_VALUE_LENGTH = 120

/**
 * Truncate rather than reject. These clauses are hints for the model, and a
 * silently shortened hint is a better outcome than a 400 the user cannot read;
 * only an absurd value is affected at all.
 */
function clause(label: string, value: string): string {
  return `${label}: ${value.slice(0, MAX_FILTER_VALUE_LENGTH)}`
}

export function buildChatContext(days: number, filters: ChatFilters): string {
  const parts = [`Time range: last ${days} days`]
  if (filters.source != null && filters.source !== '') parts.push(clause('Source', filters.source))
  if (filters.category != null && filters.category !== '') parts.push(clause('Category', filters.category))
  if (filters.sentiment != null && filters.sentiment !== '') parts.push(clause('Sentiment', filters.sentiment))
  return parts.join('. ')
}
