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

export function buildChatContext(days: number, filters: ChatFilters): string {
  const parts = [`Time range: last ${days} days`]
  if (filters.source != null && filters.source !== '') parts.push(`Source: ${filters.source}`)
  if (filters.category != null && filters.category !== '') parts.push(`Category: ${filters.category}`)
  if (filters.sentiment != null && filters.sentiment !== '') parts.push(`Sentiment: ${filters.sentiment}`)
  return parts.join('. ')
}
