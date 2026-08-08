/**
 * Whether a moment has arrived, re-rendering once when it does.
 *
 * Exists because reading `Date.now()` in a render body is impure — eslint's
 * `react-hooks/purity` rejects it, and rightly: the output would depend on when React
 * happened to re-render. Sampling once in state fixes the purity but creates a staler
 * problem, a value that never advances, so a component holding it can claim a deadline
 * is in the future long after it has passed.
 *
 * So the clock is sampled in state and advanced by a single timer, while the answer
 * itself is derived during render. That ordering matters for more than tidiness:
 * `setState` called straight from an effect is its own eslint error
 * (`react-hooks/set-state-in-effect`), and the only legitimate place to advance a clock
 * is the timer callback.
 *
 * No interval, so an idle page costs nothing, and no render loop: the timer advances
 * `now`, the effect depends only on `deadline`, so it does not re-run in response.
 *
 * Two consumers, needing the same thing for different reasons: the prototype label must
 * stop promising a window it cannot honour, and the prototype iframe must stop holding a
 * dead signature once a live replacement exists.
 */
import { useEffect, useState } from 'react'

export function useDeadlinePassed(deadline: number | null): boolean {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // No deadline is not a passed deadline — an unsigned or legacy prototype must never
    // be reported as expired.
    if (deadline == null) return

    // Clamped rather than branched: a deadline already behind us schedules an immediate
    // tick instead of an early return, which closes the gap where time crossed the
    // deadline between this render and this effect. Re-armed whenever `deadline` moves,
    // which is exactly what a re-signed URL does.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(deadline - Date.now(), 0))
    return () => clearTimeout(timer)
  }, [deadline])

  return deadline != null && deadline <= now
}
