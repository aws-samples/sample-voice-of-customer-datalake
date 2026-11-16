/**
 * The flag the shell reads while a document page is in focus view, and which moves the unsaved-changes guard lets
 * through (only full screen or the older version on screen changes: the page and its draft stay).
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { onlyDocumentViewChanged } from '../../../pages/ProjectDetail/useProjectPlace'
import { setFocusViewActive, useFocusViewActive } from './focusView'

const at = (pathname: string, search = '') => ({ pathname, search })

afterEach(() => { setFocusViewActive(false) })

describe('onlyDocumentViewChanged (the unsaved-changes guard lets these through)', () => {
  it('is true for entering or leaving the focus view, or an older version, of the same document', () => {
    expect(onlyDocumentViewChanged(at('/projects/p/documents/d'), at('/projects/p/documents/d/focus'))).toBe(true)
    expect(onlyDocumentViewChanged(at('/projects/p/documents/d/focus'), at('/projects/p/documents/d'))).toBe(true)
    expect(onlyDocumentViewChanged(at('/projects/p/documents/d'), at('/projects/p/documents/d/v/2'))).toBe(true)
    expect(onlyDocumentViewChanged(at('/projects/p/documents/d/v/2/focus'), at('/projects/p/documents/d'))).toBe(true)
  })

  it.each([
    ['another document', at('/projects/p/documents/d'), at('/projects/p/documents/e/focus')],
    ['another project', at('/projects/p/documents/d'), at('/projects/q/documents/d/focus')],
    ['another tab', at('/projects/p/documents/d'), at('/projects/p/personas')],
    ['another query', at('/projects/p/documents/d', '?a=1'), at('/projects/p/documents/d/focus')],
    ['no change at all', at('/projects/p/documents/d'), at('/projects/p/documents/d')],
    ['another page', at('/dashboard'), at('/dashboard/x')],
  ])('is false for %s', (_case, from, to) => {
    expect(onlyDocumentViewChanged(from, to)).toBe(false)
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
