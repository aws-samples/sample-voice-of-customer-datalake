/**
 * The focus view's address option (`?view=focus`) and the flag the shell reads.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { isFocusView, onlyFocusViewChanged, setFocusViewActive, useFocusViewActive, withFocusView } from './focusView'

const at = (pathname: string, search: string) => ({ pathname, search })

afterEach(() => { setFocusViewActive(false) })

describe('the view option', () => {
  it('reads `view=focus` only', () => {
    expect(isFocusView(new URLSearchParams('tab=documents&view=focus'))).toBe(true)
    expect(isFocusView(new URLSearchParams('view=list'))).toBe(false)
    expect(isFocusView(new URLSearchParams(''))).toBe(false)
  })

  it('sets and drops it, keeping every other parameter', () => {
    const on = withFocusView(new URLSearchParams('tab=documents&doc=d1'), true)
    expect(on.toString()).toBe('tab=documents&doc=d1&view=focus')
    expect(withFocusView(on, false).toString()).toBe('tab=documents&doc=d1')
  })
})

describe('onlyFocusViewChanged (the unsaved-changes guard lets these through)', () => {
  it('is true for entering or leaving the focus view on the same page', () => {
    expect(onlyFocusViewChanged(at('/projects/p', '?tab=documents&doc=d'), at('/projects/p', '?tab=documents&doc=d&view=focus'))).toBe(true)
    expect(onlyFocusViewChanged(at('/projects/p', '?doc=d&view=focus'), at('/projects/p', '?doc=d'))).toBe(true)
  })

  it('is false for another document, another path, or no change at all', () => {
    expect(onlyFocusViewChanged(at('/projects/p', '?doc=d'), at('/projects/p', '?doc=e&view=focus'))).toBe(false)
    expect(onlyFocusViewChanged(at('/projects/p', '?doc=d'), at('/projects/q', '?doc=d&view=focus'))).toBe(false)
    expect(onlyFocusViewChanged(at('/projects/p', '?doc=d'), at('/projects/p', '?doc=d'))).toBe(false)
  })
})

describe('useFocusViewActive', () => {
  it('follows the flag the page sets', () => {
    const { result } = renderHook(() => useFocusViewActive())
    expect(result.current).toBe(false)
    act(() => { setFocusViewActive(true) })
    expect(result.current).toBe(true)
    act(() => { setFocusViewActive(true) })
    expect(result.current).toBe(true)
    act(() => { setFocusViewActive(false) })
    expect(result.current).toBe(false)
  })
})
