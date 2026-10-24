/**
 * @fileoverview The copy hooks' "Copied" state turns itself off, and unmounting
 * a component mid-flash leaves no timer behind (FormCard, SourceCard and the
 * export menus used to schedule an un-cleared `setTimeout`).
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCopiedFlag } from './useCopiedFlag'
import { useCopyToClipboard } from './useCopyToClipboard'

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useCopyToClipboard', () => {
  it('writes the text and remembers which item was copied for two seconds', () => {
    const { result } = renderHook(() => useCopyToClipboard())
    act(() => result.current.copy('https://example.test/form', 'url'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://example.test/form')
    expect(result.current.copiedKey).toBe('url')
    act(() => { vi.advanceTimersByTime(2000) })
    expect(result.current.copiedKey).toBeNull()
  })

  it('leaves no pending timer when unmounted while showing "Copied"', () => {
    const { result, unmount } = renderHook(() => useCopyToClipboard())
    act(() => result.current.copy('snippet', 'iframe'))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('useCopiedFlag', () => {
  it('is true after markCopied and false two seconds later', () => {
    const { result } = renderHook(() => useCopiedFlag())
    act(() => result.current[1]())
    expect(result.current[0]).toBe(true)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(result.current[0]).toBe(false)
  })

  it('leaves no pending timer when unmounted while showing "Copied"', () => {
    const { result, unmount } = renderHook(() => useCopiedFlag())
    act(() => result.current[1]())
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
