import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResetAfter } from './useResetAfter'

describe('useResetAfter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the reset once its time has passed', () => {
    const reset = vi.fn()
    const { result } = renderHook(() => useResetAfter())
    result.current(3000, reset)
    vi.advanceTimersByTime(2999)
    expect(reset).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reset).toHaveBeenCalledExactlyOnceWith()
  })

  it('gives a newer note its full time: the pending reset is replaced, not run', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { result } = renderHook(() => useResetAfter())
    result.current(3000, first)
    vi.advanceTimersByTime(2000)
    result.current(3000, second)
    vi.advanceTimersByTime(2000)
    expect([first.mock.calls.length, second.mock.calls.length]).toStrictEqual([0, 0])
    vi.advanceTimersByTime(1000)
    expect([first.mock.calls.length, second.mock.calls.length]).toStrictEqual([0, 1])
  })

  it('cancels the pending reset when the view goes away', () => {
    const reset = vi.fn()
    const { result, unmount } = renderHook(() => useResetAfter())
    result.current(3000, reset)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(reset).not.toHaveBeenCalled()
  })

  it('is the same function on every render (safe in effect and callback deps)', () => {
    const { result, rerender } = renderHook(() => useResetAfter())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
