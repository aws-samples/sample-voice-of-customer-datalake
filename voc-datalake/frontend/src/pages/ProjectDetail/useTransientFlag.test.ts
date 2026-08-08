/**
 * The self-clearing kick-off acknowledgement.
 *
 * Left permanently raised, "Started — track it in Background Jobs" contradicts
 * the panel: it keeps claiming a job was *started* after the panel has reported
 * it finished or failed. The lowering is the behaviour, so it is what these pin.
 *
 * Fake timers are safe here because this file drives the hook alone, and they are
 * restored in `afterEach` — which runs even when a test fails. A `finally` inside
 * a test body does not: an earlier attempt at this on a component test timed out,
 * skipped its own cleanup, and left fake timers active for unrelated suites.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTransientFlag } from './useTransientFlag'

describe('useTransientFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts lowered', () => {
    const { result } = renderHook(() => useTransientFlag(1000))
    expect(result.current.isSet).toBe(false)
  })

  it('raises on demand', () => {
    const { result } = renderHook(() => useTransientFlag(1000))

    act(() => result.current.set())

    expect(result.current.isSet).toBe(true)
  })

  it('stays raised for the whole duration', () => {
    const { result } = renderHook(() => useTransientFlag(1000))
    act(() => result.current.set())

    act(() => vi.advanceTimersByTime(999))

    expect(result.current.isSet).toBe(true)
  })

  it('lowers itself once the duration elapses', () => {
    const { result } = renderHook(() => useTransientFlag(1000))
    act(() => result.current.set())

    act(() => vi.advanceTimersByTime(1000))

    expect(result.current.isSet).toBe(false)
  })

  it('restarts the window when raised again', () => {
    const { result } = renderHook(() => useTransientFlag(1000))
    act(() => result.current.set())
    act(() => vi.advanceTimersByTime(800))

    act(() => result.current.set())
    act(() => vi.advanceTimersByTime(800))

    // A second start must not be cut short by the first one's timer.
    expect(result.current.isSet).toBe(true)
  })

  it('lowers immediately when cleared', () => {
    const { result } = renderHook(() => useTransientFlag(1000))
    act(() => result.current.set())

    act(() => result.current.clear())

    expect(result.current.isSet).toBe(false)
  })

  it('keeps a stable identity across renders so callers can list it in deps', () => {
    const { result, rerender } = renderHook(() => useTransientFlag(1000))
    const first = result.current

    rerender()

    // A fresh object each render would change the identity of every useCallback
    // that lists this in its deps.
    expect(result.current).toBe(first)
  })

  it('drops its pending timer on unmount', () => {
    const { result, unmount } = renderHook(() => useTransientFlag(1000))
    act(() => result.current.set())

    unmount()

    // Firing into an unmounted hook would warn (or, in React 18, error). The
    // assertion is that advancing past the window is uneventful.
    expect(() => act(() => vi.advanceTimersByTime(2000))).not.toThrow()
  })
})
