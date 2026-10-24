/**
 * @fileoverview Query-string helpers for pages that mirror their own state to
 * the URL. A page owns a fixed set of keys; every other param (the review
 * modal's `?review=` / `reviewBrand`, another feature's deep link) belongs to
 * someone else and must survive the page's write-back.
 *
 * @module utils/searchParams
 */

/**
 * `current` with every key in `owned` replaced by what `next` says (a key
 * absent from `next` is removed); every other param is kept as it was.
 */
export function withOwnedParams(
  current: URLSearchParams,
  owned: readonly string[],
  next: URLSearchParams,
): URLSearchParams {
  const kept = [...current].filter(([key]) => !owned.includes(key))
  return new URLSearchParams([...kept, ...next])
}
