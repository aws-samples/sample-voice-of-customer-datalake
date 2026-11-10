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

  it('tryCopy marks the item only once the write resolved, and answers whether it did', async () => {
    const { result } = renderHook(() => useCopyToClipboard())
    const ok = await act(() => result.current.tryCopy('https://example.test/board', 'link'))
    expect([ok, result.current.copiedKey]).toStrictEqual([true, 'link'])
  })

  it('tryCopy shows nothing and answers false when the browser refuses the write', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'))
    const { result } = renderHook(() => useCopyToClipboard())
    const ok = await act(() => result.current.tryCopy('https://example.test/board', 'link'))
    expect([ok, result.current.copiedKey]).toStrictEqual([false, null])
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
