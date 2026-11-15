/**
 * @fileoverview "Now" for relative dates ("5 min. ago"), refreshed every minute so they do not freeze.
 *
 * @module hooks/useNow
 */
import { useEffect, useState } from 'react'

const NOW_TICK_MS = 60_000

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}
