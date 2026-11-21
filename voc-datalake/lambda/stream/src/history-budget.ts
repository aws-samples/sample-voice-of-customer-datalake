/**
 * Conversation-history budget: how much prior turn text is replayed to the model.
 *
 * Used by `assistant/runtime/flatten.ts`, which renders everything before the
 * newest user message as plain text turns and clamps them with
 * `clampHistoryToBudget`.
 *
 * ## Why this CLAMPS instead of rejecting
 *
 * History carries text this service itself generated. The assistant streams
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
 * `MAX_HISTORY_CONTENT_LENGTH` is *derived* from `MAX_OUTPUT_TOKENS` below rather
 * than chosen, so the two cannot drift: the longest answer the service can emit is
 * the longest entry it must accept back. `converseStream` takes its default
 * `maxTokens` from that same constant. `CHARS_PER_TOKEN = 4` is the usual
 * conservative English approximation.
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

/** The share of a custom model's input window the replayed history may take (7.65.00: a 32,000-token chat model). */
const HISTORY_WINDOW_SHARE = 0.25;

/** How much replayed history fits: its aggregate and its longest turn, in characters. */
export interface HistoryBudget {
  readonly total: number;
  readonly entry: number;
}

/** A Claude's (its window holds four full answers beside the prompt, the context and the tool results). */
export const DEFAULT_HISTORY_BUDGET: HistoryBudget = { total: MAX_HISTORY_TOTAL_LENGTH, entry: MAX_HISTORY_CONTENT_LENGTH };

/**
 * The history budget for a model of `windowTokens` (undefined: a Claude, the defaults): a quarter of a custom model's
 * window, never more than a Claude's, so a 32,000-token chat model is resent about 8,000 tokens of history rather than
 * 64,000 it cannot hold.
 */
export function historyBudgetFor(windowTokens: number | undefined): HistoryBudget {
  if (windowTokens === undefined) return DEFAULT_HISTORY_BUDGET;
  const total = Math.min(MAX_HISTORY_TOTAL_LENGTH, Math.floor(windowTokens * HISTORY_WINDOW_SHARE) * CHARS_PER_TOKEN);
  return { total, entry: Math.min(MAX_HISTORY_CONTENT_LENGTH, total) };
}

/**
 * Appended when a single turn is truncated, so the model can tell that it is
 * seeing a partial turn rather than an answer that simply stopped mid-sentence.
 */
export const TRUNCATION_MARKER = '\n\n[... truncated]';

interface HistoryLike {
  readonly content: string;
}

function truncateEntry<T extends HistoryLike>(entry: T, longest: number): T {
  if (entry.content.length <= longest) return entry;
  const keep = longest - TRUNCATION_MARKER.length;
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
export function clampHistoryToBudget<T extends HistoryLike>(history: readonly T[],
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET): T[] {
  // Prepending is O(n^2), bounded by MAX_HISTORY_ENTRIES, so it stays trivial.
  const kept = history
    .slice(-MAX_HISTORY_ENTRIES)
    .map((entry) => truncateEntry(entry, budget.entry))
    .reduceRight<Budget<T>>(
    (acc, entry) => {
      if (acc.full) return acc;
      const total = acc.total + entry.content.length;
      if (total > budget.total) {
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
