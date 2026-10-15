/**
 * A deadline that flips itself.
 *
 * Two consumers depend on this being right for different reasons: the prototype label
 * must stop promising a window that has closed, and the prototype iframe must stop
 * holding a dead signature once a live one exists. The cases that matter are all about
 * elapsed time, so fake timers are unavoidable here — they are confined to this file
 * and torn down after each test, because they have leaked across files in this suite.
 */
import { renderHook, act } from '@testing-library/react'
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import { useDeadlinePassed } from './useDeadlinePassed'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDeadlinePassed', () => {
  // Captured ONCE, outside the render callback. Computing `Date.now() + 60_000` inside
  // it recomputes on every render, so the deadline runs away from the advancing clock
  // and the hook can never reach it — which looks exactly like the hook being broken.
  const deadlineIn = (ms: number) => Date.now() + ms

  it('is false while the deadline is still ahead', () => {
    const deadline = deadlineIn(60_000)
    const { result } = renderHook(() => useDeadlinePassed(deadline))
    expect(result.current).toBe(false)
  })

  it('is true immediately for a deadline already behind us', () => {
    // The mount case that matters: a component rendering against stale cached data.
    const deadline = deadlineIn(-1)
    const { result } = renderHook(() => useDeadlinePassed(deadline))
    expect(result.current).toBe(true)
  })

  it('flips on its own when the deadline arrives, with no other trigger', () => {
    const deadline = deadlineIn(60_000)
    const { result } = renderHook(() => useDeadlinePassed(deadline))
    expect(result.current).toBe(false)

    act(() => {
      vi.advanceTimersByTime(60_001)
    })

    expect(result.current).toBe(true)
  })

  it('does not flip early', () => {
    const deadline = deadlineIn(60_000)
    const { result } = renderHook(() => useDeadlinePassed(deadline))
    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    expect(result.current).toBe(false)
  })

  it('is false for no deadline, so an unsigned link is never called expired', () => {
    const { result } = renderHook(() => useDeadlinePassed(null))
    expect(result.current).toBe(false)
  })

  /**
   * A re-signed URL carries a later deadline. If the hook kept the old answer, the
   * label would stay stuck on "expired" and the iframe would keep adopting.
   */
  it('follows a deadline that moves later', () => {
    const start = Date.now()
    const { result, rerender } = renderHook(
      ({ deadline }: { deadline: number }) => useDeadlinePassed(deadline),
      { initialProps: { deadline: start + 1_000 } },
    )

    act(() => {
      vi.advanceTimersByTime(1_500)
    })
    expect(result.current).toBe(true)

    rerender({ deadline: start + 600_000 })
    expect(result.current).toBe(false)
  })

  it('clears its timer on unmount rather than firing into a dead component', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { unmount } = renderHook(() => useDeadlinePassed(Date.now() + 60_000))
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
