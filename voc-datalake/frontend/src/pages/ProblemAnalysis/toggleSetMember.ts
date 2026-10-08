/**
 * @fileoverview Immutable Set toggle for the tree's expanded-key state.
 * @module pages/ProblemAnalysis/toggleSetMember
 */

/** A copy of `set` with `key` removed when present and added when absent. */
export function toggleSetMember<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
