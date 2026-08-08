/**
 * A boolean that raises on demand and lowers itself shortly after.
 *
 * The kick-off acknowledgements ("Started — track it in Background Jobs") exist
 * only to cover the gap before the jobs panel's next refetch shows the job. Left
 * to themselves they would sit on screen indefinitely, still claiming a job was
 * *started* long after the panel has reported it finished or failed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Long enough to read, short enough that the panel has taken over by then. */
const DEFAULT_DURATION_MS = 8000

export function useTransientFlag(durationMs = DEFAULT_DURATION_MS): {
  readonly isSet: boolean
  readonly set: () => void
  readonly clear: () => void
} {
  const [isSet, setIsSet] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelTimer = useCallback(() => {
    if (timer.current != null) clearTimeout(timer.current)
    timer.current = null
  }, [])

  const clear = useCallback(() => {
    cancelTimer()
    setIsSet(false)
  }, [cancelTimer])

  const set = useCallback(() => {
    cancelTimer()
    setIsSet(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setIsSet(false)
    }, durationMs)
  }, [cancelTimer, durationMs])

  // Unmounting mid-window must not leave a timer holding a setState.
  useEffect(() => cancelTimer, [cancelTimer])

  return { isSet, set, clear }
}
