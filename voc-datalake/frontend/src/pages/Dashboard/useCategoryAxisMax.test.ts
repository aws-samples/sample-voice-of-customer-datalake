/**
 * @fileoverview The category-axis cap follows the `sm` breakpoint, and updates
 * when the viewport crosses it.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCategoryAxisMax } from './useCategoryAxisMax'

interface FakeQuery {
  matches: boolean
  readonly listeners: Set<() => void>
}

function stubViewport(wide: boolean): FakeQuery {
  const fake: FakeQuery = { matches: wide, listeners: new Set() }
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query === '(min-width: 640px)' && fake.matches },
    addEventListener: (_type: string, listener: () => void) => { fake.listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { fake.listeners.delete(listener) },
  }))
  return fake
}

describe('useCategoryAxisMax', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('keeps the phone cap below sm and widens from sm up', () => {
    stubViewport(false)
    const narrow = renderHook(() => useCategoryAxisMax()).result.current
    stubViewport(true)
    const wide = renderHook(() => useCategoryAxisMax()).result.current
    expect([narrow, wide]).toStrictEqual([128, 200])
  })

  it('follows the viewport across the breakpoint', () => {
    const fake = stubViewport(false)
    const { result } = renderHook(() => useCategoryAxisMax())
    act(() => {
      fake.matches = true
      fake.listeners.forEach((listener) => { listener() })
    })
    expect(result.current).toBe(200)
  })
})
