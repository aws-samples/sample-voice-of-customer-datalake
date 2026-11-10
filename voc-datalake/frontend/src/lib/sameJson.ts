/**
 * @fileoverview Structural equality of JSON-shaped values (drafts against their
 * saved copy, a field before and after a change).
 * @module lib/sameJson
 */

/**
 * True when `a` and `b` serialise to the same JSON. Key order counts, as in every
 * caller: both sides come from the same normaliser, so equal values list their
 * keys alike. `undefined` is not `null` here (a caller that treats them alike
 * says so: `sameJson(a ?? null, b ?? null)`).
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}
