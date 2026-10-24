/**
 * @fileoverview A value that follows its input only after the input has been
 * still for `delayMs` — so a search box sends one request per typed query, not
 * one per keystroke.
 *
 * @module hooks/useDebouncedValue
 */
import { useEffect, useState } from 'react'

/** The default pause before a typed search is sent. */
const SEARCH_DEBOUNCE_MS = 300

export function useDebouncedValue<T>(value: T, delayMs: number = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}
