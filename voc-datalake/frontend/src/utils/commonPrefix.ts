/**
 * @fileoverview How long a start two sequences share: two texts (by UTF-16 unit, as string offsets are) or two lists
 * of lines. The one helper the line diff, the comment anchors and "Revise from comments" use.
 *
 * @module utils/commonPrefix
 */

/** How many leading items (characters of a string, entries of a list) `a` and `b` have in common. */
export function commonPrefixLength<T>(a: ArrayLike<T>, b: ArrayLike<T>): number {
  const limit = Math.min(a.length, b.length)
  const differs = Array.from({ length: limit }, (_, i) => i).find((i) => a[i] !== b[i])
  return differs ?? limit
}
