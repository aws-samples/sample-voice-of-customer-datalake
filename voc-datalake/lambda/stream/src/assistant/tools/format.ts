/**
 * Shaping helpers for tool results: the model reads compact text/JSON with a
 * bounded size, never whole raw records.
 */

/** Default per-tool result budget, in characters. */
const DEFAULT_RESULT_BUDGET = 12_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clip a string to `max` characters, marking the cut. */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Bound a tool result. When cut, the content SAYS so — the consumer is the
 * model, and a silently shortened result reads as a complete one.
 */
export function withinBudget(content: string, budget: number = DEFAULT_RESULT_BUDGET): string {
  if (content.length <= budget) return content;
  return `${content.slice(0, budget)}\n\n[TRUNCATED: showing the first ${budget} of ${content.length} characters. `
    + 'Say that the result was cut if it matters for the answer, or ask a narrower question.]';
}

function clipValue(value: unknown, maxString: number): unknown {
  if (typeof value === 'string') return clip(value, maxString);
  return value;
}

/**
 * Copy the listed keys that are present (and not null/empty-string), clipping
 * strings. Unknown keys never pass — a field added to a record upstream does
 * not reach the prompt without somebody deciding it should.
 */
export function pick(
  record: Record<string, unknown>,
  keys: readonly string[],
  maxString = 600,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null || value === '') continue;
    out[key] = clipValue(value, maxString);
  }
  return out;
}

/** Compact JSON for the model, bounded. */
export function jsonResult(value: unknown, budget: number = DEFAULT_RESULT_BUDGET): string {
  return withinBudget(JSON.stringify(value), budget);
}

/** First string among the values, or undefined. */
export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
