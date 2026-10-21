/**
 * @fileoverview `value`, once it has stopped changing for `delayMs`.
 *
 * The filter panels update their checkboxes instantly but feed the server
 * through this, so ticking five boxes in a row costs one scan instead of five.
 * The first render returns `value` as-is (a page opened with remembered or
 * deep-linked filters loads immediately); only later changes wait.
 *
 * @module hooks/useDebouncedValue
 */
import { useEffect, useState } from 'react'

/** How long a filter selection must be still before the pages re-query. */
export const FILTER_QUERY_DEBOUNCE_MS = 400

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
