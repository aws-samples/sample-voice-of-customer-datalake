import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useExpiringValue } from './useExpiringValue'

describe('useExpiringValue', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('holds a value for its time, then clears it', () => {
    const { result } = renderHook(() => useExpiringValue<string>(5000))
    act(() => { result.current[1]('Upload failed') })
    expect(result.current[0]).toBe('Upload failed')
    act(() => { vi.advanceTimersByTime(4999) })
    expect(result.current[0]).toBe('Upload failed')
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current[0]).toBeNull()
  })

  it('gives a newer value its full time', () => {
    const { result } = renderHook(() => useExpiringValue<string>(5000))
    act(() => { result.current[1]('first') })
    act(() => { vi.advanceTimersByTime(4000) })
    act(() => { result.current[1]('second') })
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current[0]).toBe('second')
  })

  it('gives the same message shown again its full time', () => {
    const { result } = renderHook(() => useExpiringValue<string>(5000))
    act(() => { result.current[1]('Upload failed') })
    act(() => { vi.advanceTimersByTime(4000) })
    act(() => { result.current[1]('Upload failed') })
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current[0]).toBe('Upload failed')
  })

  it('clears at once on clear(), and leaves no timer running', () => {
    const { result } = renderHook(() => useExpiringValue<boolean>(3000))
    act(() => { result.current[1](true) })
    act(() => { result.current[2]() })
    expect(result.current[0]).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer behind when the component unmounts', () => {
    const { result, unmount } = renderHook(() => useExpiringValue<string>(5000))
    act(() => { result.current[1]('Upload failed') })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
