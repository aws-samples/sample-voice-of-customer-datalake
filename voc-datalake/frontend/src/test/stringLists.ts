/**
 * @fileoverview String-list helpers for spec assertions: deterministic
 * ordering, and narrowing a loosely typed option to a string list.
 *
 * `Array#sort()` without a comparator orders by UTF-16 code unit, which is
 * fine for ASCII names but reads as an accident to a reviewer (and to
 * `sonarjs/no-alphabetical-sort`). Specs that compare two sorted lists sort
 * BOTH sides with this, so the comparator only has to be consistent.
 */

/** A sorted copy of `values` (the input is not mutated). */
export function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b))
}

/**
 * Narrow an i18next option that is typed loosely (`string | readonly string[] |
 * false`, …) to the string list it is configured as, failing loudly otherwise.
 */
export function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a list`)
  return value.map((item: unknown) => {
    if (typeof item !== 'string') throw new Error(`${label} holds a non-string entry`)
    return item
  })
}
