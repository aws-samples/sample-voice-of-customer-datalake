/**
 * Tests for the conversation-history budget (issue #266 follow-up).
 *
 * The behaviour under test is "clamp, never reject", so these assert on the
 * SHAPE of the returned window rather than on a boolean. The regression that
 * matters: a replayed assistant answer longer than the old 4 000-char cap must
 * survive, because the service generated it.
 */
import { describe, it, expect } from 'vitest';
import {
  clampHistoryToBudget,
  MAX_HISTORY_CONTENT_LENGTH,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_TOTAL_LENGTH,
  MAX_OUTPUT_TOKENS,
  TRUNCATION_MARKER,
} from './history-budget.js';


function turn(content: string, role: 'user' | 'assistant' = 'assistant') {
  return {
    role, content,
  };
}

describe('derived bounds', () => {
  it('accepts a turn as long as the longest answer the service can emit', () => {
    // The whole point of the derivation: 4 chars/token against the model ceiling.
    expect(MAX_HISTORY_CONTENT_LENGTH).toBe(MAX_OUTPUT_TOKENS * 4);
    const longest = turn('a'.repeat(MAX_HISTORY_CONTENT_LENGTH));
    expect(clampHistoryToBudget([longest])[0]?.content).toHaveLength(MAX_HISTORY_CONTENT_LENGTH);
  });

  it('leaves the aggregate ceiling above a single full-length turn', () => {
    expect(MAX_HISTORY_TOTAL_LENGTH).toBeGreaterThan(MAX_HISTORY_CONTENT_LENGTH);
  });
});

describe('clampHistoryToBudget', () => {
  it('returns short history untouched', () => {
    const history = [turn('question', 'user'), turn('answer')];
    expect(clampHistoryToBudget(history)).toStrictEqual(history);
  });

  it('returns an empty window for empty history', () => {
    expect(clampHistoryToBudget([])).toStrictEqual([]);
  });

  it('truncates an over-long turn to exactly the bound, marker included', () => {
    const [entry] = clampHistoryToBudget([turn('a'.repeat(MAX_HISTORY_CONTENT_LENGTH + 1))]);
    expect(entry?.content).toHaveLength(MAX_HISTORY_CONTENT_LENGTH);
    expect(entry?.content.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('preserves the role when truncating', () => {
    const [entry] = clampHistoryToBudget([turn('a'.repeat(MAX_HISTORY_CONTENT_LENGTH + 1), 'user')]);
    expect(entry?.role).toBe('user');
  });

  it('keeps only the most recent turns once the count budget is spent', () => {
    const history = Array.from(
      { length: MAX_HISTORY_ENTRIES + 10 },
      (_, i) => turn(`turn-${i}`, 'user'),
    );
    const kept = clampHistoryToBudget(history);
    expect(kept).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(kept.at(-1)?.content).toBe(`turn-${MAX_HISTORY_ENTRIES + 9}`);
    expect(kept[0]?.content).toBe('turn-10');
  });

  it('drops the oldest turns once the character budget is spent', () => {
    // Five full-length turns exceed the aggregate ceiling of four.
    const history = Array.from({ length: 5 }, () => turn('a'.repeat(MAX_HISTORY_CONTENT_LENGTH)));
    const kept = clampHistoryToBudget(history);
    expect(kept).toHaveLength(4);
    const total = kept.reduce((sum, e) => sum + e.content.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_HISTORY_TOTAL_LENGTH);
  });

  it('keeps a CONTIGUOUS window ending at the newest turn, never one with a hole', () => {
    // Walking back from the newest turn, the budget is spent part-way through
    // filler A. A naive "skip what does not fit and carry on" filter would then
    // squeeze the tiny oldest turn into the leftover headroom, handing the model
    // a conversation missing its middle. Ordered oldest -> newest:
    //   tiny (11) | A 64k | B 64k | C 64k | D 64k | newest (6)
    // Backwards: 6 + 64k + 64k + 64k = 192 006, then A would make 256 006 which
    // exceeds the 256 000 ceiling -> stop. `tiny` still fits, and must NOT be kept.
    const filler = (char: string) => turn(char.repeat(MAX_HISTORY_CONTENT_LENGTH));
    const history = [
      turn('tiny-oldest', 'user'),
      filler('A'), filler('B'), filler('C'), filler('D'),
      turn('newest', 'user'),
    ];

    const kept = clampHistoryToBudget(history);

    expect(kept).toHaveLength(4);
    expect(kept.map((e) => e.content.slice(0, 1))).toStrictEqual(['B', 'C', 'D', 'n']);
    expect(kept.some((e) => e.content === 'tiny-oldest')).toBe(false);
  });

  it('always keeps the newest turn', () => {
    const history = [turn('a'.repeat(MAX_HISTORY_CONTENT_LENGTH)), turn('newest', 'user')];
    expect(clampHistoryToBudget(history).at(-1)?.content).toBe('newest');
  });
});
