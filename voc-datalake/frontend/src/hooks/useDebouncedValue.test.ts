import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDebouncedValue } from './useDebouncedValue'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDebouncedValue', () => {
  it('returns the first value immediately, so a page with remembered filters loads at once', () => {
    const { result } = renderHook(() => useDebouncedValue('initial', 400))
    expect(result.current).toBe('initial')
  })

  it('holds a change until the value has been still for the delay', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 400), {
      initialProps: { value: 'a' },
    })

    rerender({ value: 'b' })
    act(() => vi.advanceTimersByTime(399))
    expect(result.current).toBe('a')

    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe('b')
  })

  it('restarts the wait on every change, emitting only the last of a quick burst', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 400), {
      initialProps: { value: 1 },
    })

    for (const next of [2, 3, 4]) {
      rerender({ value: next })
      act(() => vi.advanceTimersByTime(300))
    }
    expect(result.current).toBe(1)

    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe(4)
  })

  it('leaves no pending timer behind when it unmounts mid-wait', () => {
    const { rerender, unmount } = renderHook(({ value }) => useDebouncedValue(value, 400), {
      initialProps: { value: 'a' },
    })
    rerender({ value: 'b' })
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
