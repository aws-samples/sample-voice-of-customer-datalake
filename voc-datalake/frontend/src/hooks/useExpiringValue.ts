/**
 * @fileoverview A value that clears itself: `show(value)` holds it for `ms`, then it goes back to `null`; `clear()`
 * drops it at once. The timer belongs to the component, so it is cleared when a new value is shown, on `clear()` and
 * when the component unmounts (a bare `setTimeout` outlived its component and set state after unmount).
 * @module hooks/useExpiringValue
 */
import { useEffect, useState } from 'react'
import { noCleanup } from './noCleanup'

export function useExpiringValue<T>(ms: number): readonly [T | null, (value: T) => void, () => void] {
  // A fresh box per show, so the same value shown twice still restarts its time.
  const [shown, setShown] = useState<{ value: T } | null>(null)
  useEffect(() => {
    if (shown === null) return noCleanup
    const timer = setTimeout(() => setShown(null), ms)
    return () => clearTimeout(timer)
  }, [shown, ms])
  return [shown === null ? null : shown.value, (value: T) => setShown({ value }), () => setShown(null)]
}
