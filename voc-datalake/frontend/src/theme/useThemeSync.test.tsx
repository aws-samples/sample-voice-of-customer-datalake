import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThemeStore } from './themeStore'
import { useThemeSync } from './useThemeSync'

type Listener = () => void

/** matchMedia stub whose "OS dark mode" can be flipped, firing change listeners. */
function systemSchemeStub() {
  const state = { dark: false }
  const listeners = new Set<Listener>()
  const original = window.matchMedia
  return {
    /** Install the stub with the given OS scheme and no listeners. */
    install(initialDark: boolean) {
      state.dark = initialDark
      listeners.clear()
      window.matchMedia = vi.fn().mockImplementation((media: string) => ({
        get matches() { return state.dark },
        media,
        addEventListener: (_: string, fn: Listener) => { listeners.add(fn) },
        removeEventListener: (_: string, fn: Listener) => { listeners.delete(fn) },
      }))
    },
    setDark(next: boolean) {
      state.dark = next
      listeners.forEach((fn) => { fn() })
    },
    listenerCount: () => listeners.size,
    restore: () => { window.matchMedia = original },
  }
}

describe('useThemeSync', () => {
  const scheme = systemSchemeStub()

  beforeEach(() => {
    useThemeStore.setState({ preference: 'system' })
    scheme.install(true)
  })
  afterEach(() => { scheme.restore() })

  const html = () => document.documentElement.dataset

  it('applies the OS scheme under the system preference', () => {
    renderHook(() => { useThemeSync() })
    expect(html().theme).toBe('kiro-dark')
    expect(html().mode).toBe('dark')
    expect(html().modePref).toBe('system')
  })

  it('follows a live OS scheme change under the system preference', () => {
    renderHook(() => { useThemeSync() })
    act(() => { scheme.setDark(false) })
    expect(html().theme).toBe('kiro-light')
  })

  it('ignores the OS scheme when an explicit preference is set', () => {
    renderHook(() => { useThemeSync() })
    act(() => { useThemeStore.getState().setPreference('light') })
    expect(html().theme).toBe('kiro-light')
    act(() => { scheme.setDark(true) })
    expect(html().theme).toBe('kiro-light')
    expect(html().modePref).toBe('light')
  })

  it('stops listening to the OS on unmount', () => {
    const { unmount } = renderHook(() => { useThemeSync() })
    expect(scheme.listenerCount()).toBeGreaterThan(0)
    unmount()
    expect(scheme.listenerCount()).toBe(0)
  })
})
