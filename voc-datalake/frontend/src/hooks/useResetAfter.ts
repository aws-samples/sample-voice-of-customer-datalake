/**
 * @fileoverview The timer behind a note that clears itself ("Saved!", an upload's success or error banner):
 * `resetAfter(ms, reset)` runs `reset` once `ms` have passed. A newer call replaces the pending one (each note
 * gets its full time), and unmounting cancels it, so no state update fires on a view that is gone (in the unit
 * tests such a timer fired after the test environment was torn down and failed the run).
 * @module hooks/useResetAfter
 */
import { useCallback, useEffect, useRef } from 'react'

export function useResetAfter(): (ms: number, reset: () => void) => void {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return useCallback((ms: number, reset: () => void) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(reset, ms)
  }, [])
}
