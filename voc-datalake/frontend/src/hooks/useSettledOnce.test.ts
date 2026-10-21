import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSettledOnce } from './useSettledOnce'

describe('useSettledOnce', () => {
  it('is false during the first load and true once it finishes', () => {
    const { result, rerender } = renderHook(({ loading }) => useSettledOnce(loading), {
      initialProps: { loading: true },
    })
    expect(result.current).toBe(false)

    rerender({ loading: false })
    expect(result.current).toBe(true)
  })

  it('stays true when a later load starts, so the page never drops back to a full-page spinner', () => {
    const { result, rerender } = renderHook(({ loading }) => useSettledOnce(loading), {
      initialProps: { loading: false },
    })
    expect(result.current).toBe(true)

    rerender({ loading: true })
    expect(result.current).toBe(true)
  })
})
