/**
 * Conversation-history budget: how much prior turn text the client may replay.
 *
 * ## Why this CLAMPS instead of rejecting
 *
 * `history` carries text this service itself generated. `handleVocChat` streams
 * with `maxTokens: MAX_OUTPUT_TOKENS`, the client replays that answer verbatim
 * on the next turn, and Converse is stateless so the whole array is resent every
 * round. Any per-entry bound below the model's own output ceiling therefore turns
 * one normal long answer into a 400 on *every subsequent message* — the
 * conversation is dead, the answer is still on screen, and the error names no
 * field. Truncating degrades gracefully; rejecting does not.
 *
 * Clamping is also the established pattern for context elsewhere in this
 * codebase (persona context and per-document context are truncated to a
 * character budget, never refused).
 *
 * ## Where the numbers come from
 *
 * `MAX_HISTORY_CONTENT_LENGTH` is *derived* from the model's output ceiling
 * rather than chosen, so the two cannot drift: it reads
 * `DEFAULT_MAX_OUTPUT_TOKENS` straight off the Converse wrapper, because the
 * longest answer the service can emit is the longest entry it must accept back.
 * `CHARS_PER_TOKEN = 4` is the usual conservative English approximation.
 *
 * `MAX_HISTORY_TOTAL_LENGTH` bounds the aggregate, which is the term that
 * actually costs money once it is resent each tool round. Four full-length
 * answers' worth (~64 000 tokens) leaves ample room inside the model's input
 * window for the system prompt, corpus context and tool results. Older turns
 * beyond the budget are dropped — standard sliding-window chat behaviour — so
 * the request always stays inside the envelope without ever being refused.
 *
 * `MAX_HISTORY_ENTRIES` is enforced here, by the same sliding window, rather
 * than as a `.max()` on the array in the schema. It was a rejection before, and
 * it carried the identical defect to the per-entry cap one level up: a
 * conversation that naturally reaches turn 51 would 400 from then on. The count
 * is a budget, so it is spent like one.
 */

/**
 * Output-token ceiling for a streamed answer, i.e. the longest reply this service
 * can emit. `converseStream` imports this as its default `maxTokens`, so the
 * ceiling and the bound derived from it below are one constant.
 *
 * It lives in this module, not next to the Converse call, on purpose: this module
 * is pure, so nothing that needs the number has to pull the Bedrock SDK (or a
 * mock of it) into its import graph. Callers may pass a smaller value — roundtable
 * does — but nothing passes a larger one.
 */
export const MAX_OUTPUT_TOKENS = 16_000;

/** Conservative chars-per-token approximation for English prose. */
const CHARS_PER_TOKEN = 4;

/** Longest single replayed turn, i.e. the longest answer the service can emit. */
export const MAX_HISTORY_CONTENT_LENGTH = MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN;

/** Aggregate ceiling across all replayed turns. */
export const MAX_HISTORY_TOTAL_LENGTH = MAX_HISTORY_CONTENT_LENGTH * 4;

/** Most recent turns kept, regardless of length. */
export const MAX_HISTORY_ENTRIES = 50;

/**
 * Appended when a single turn is truncated, so the model can tell that it is
 * seeing a partial turn rather than an answer that simply stopped mid-sentence.
 */
export const TRUNCATION_MARKER = '\n\n[... truncated]';

interface HistoryLike {
  readonly content: string;
}

function truncateEntry<T extends HistoryLike>(entry: T): T {
  if (entry.content.length <= MAX_HISTORY_CONTENT_LENGTH) return entry;
  const keep = MAX_HISTORY_CONTENT_LENGTH - TRUNCATION_MARKER.length;
  return {
    ...entry, content: entry.content.slice(0, keep) + TRUNCATION_MARKER,
  };
}

interface Budget<T> {
  readonly total: number;
  readonly full: boolean;
  readonly entries: readonly T[];
}

/**
 * Truncate over-long turns, then keep the most recent turns that fit the
 * aggregate budget.
 *
 * The kept window is always contiguous and ends at the newest turn: once the
 * budget is spent the walk stops rather than skipping a large turn to squeeze in
 * an older small one, which would hand the model a conversation with a hole in
 * the middle.
 */
export function clampHistoryToBudget<T extends HistoryLike>(history: readonly T[]): T[] {
  // Prepending is O(n^2), bounded by MAX_HISTORY_ENTRIES, so it stays trivial.
  const kept = history
    .slice(-MAX_HISTORY_ENTRIES)
    .map(truncateEntry)
    .reduceRight<Budget<T>>(
    (acc, entry) => {
      if (acc.full) return acc;
      const total = acc.total + entry.content.length;
      if (total > MAX_HISTORY_TOTAL_LENGTH) {
        return {
          ...acc, full: true,
        };
      }
      return {
        total, full: false, entries: [entry, ...acc.entries],
      };
    },
    {
      total: 0, full: false, entries: [],
    },
  );
  return [...kept.entries];
}
