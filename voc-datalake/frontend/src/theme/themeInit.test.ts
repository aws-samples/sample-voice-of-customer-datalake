/**
 * Pins the contract between public/theme-init.js (pre-paint, plain JS) and
 * themeStore.ts (runtime): same storage key, persisted shape and attributes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme, DEFAULT_THEME_PREFERENCE, isThemePreference, nextPreference, resolveMode, THEME_STORAGE_KEY, useThemeStore,
} from './themeStore'

/** The shipped pre-paint script, relative to this spec. */
const SCRIPT_PATH = '../../public/theme-init.js'

const THEME_ATTRIBUTES = ['data-theme', 'data-mode', 'data-mode-pref'] as const

/** A fresh query per run, so the module loader evaluates the script every time. */
const runs = { count: 0 }

/**
 * Execute theme-init.js against this window with the given stored value and
 * OS preference, and return what it wrote on <html>. The script is an IIFE,
 * so importing it IS running it — no eval of its source text.
 */
async function runInit(stored: string | null, prefersDark: boolean): Promise<Record<string, string | null>> {
  const html = document.documentElement
  for (const name of THEME_ATTRIBUTES) html.removeAttribute(name)
  vi.mocked(window.localStorage.getItem).mockImplementation((key: string) => (key === THEME_STORAGE_KEY ? stored : null))
  vi.stubGlobal('matchMedia', () => ({ matches: prefersDark }))
  runs.count += 1
  try {
    await import(/* @vite-ignore */ `${SCRIPT_PATH}?run=${String(runs.count)}`)
    return { theme: html.dataset.theme ?? null, mode: html.dataset.mode ?? null, modePref: html.dataset.modePref ?? null }
  } finally {
    vi.unstubAllGlobals()
    vi.mocked(window.localStorage.getItem).mockReturnValue(null)
    for (const name of THEME_ATTRIBUTES) html.removeAttribute(name)
  }
}

describe('theme-init.js', () => {
  it.each([
    [null, true, 'kiro-dark', 'dark', 'dark'],
    [null, false, 'kiro-dark', 'dark', 'dark'],
    ['{"state":{"preference":"light"},"version":0}', true, 'kiro-light', 'light', 'light'],
    ['{"state":{"preference":"dark"},"version":0}', false, 'kiro-dark', 'dark', 'dark'],
    ['{"state":{"preference":"system"},"version":0}', false, 'kiro-light', 'light', 'system'],
    ['{"state":{"preference":"neon"}}', false, 'kiro-dark', 'dark', 'dark'],
    ['not json', false, 'kiro-dark', 'dark', 'dark'],
  ])('stored=%s prefersDark=%s → %s', async (stored, prefersDark, theme, mode, pref) => {
    expect(await runInit(stored, prefersDark)).toStrictEqual({ theme, mode, modePref: pref })
  })

  it('defaults to the same preference as the store', async () => {
    expect((await runInit(null, false)).modePref).toBe(DEFAULT_THEME_PREFERENCE)
  })

  it('reads exactly what the store persists', async () => {
    // setup.ts mocks localStorage, so capture what persist writes.
    const setItem = vi.mocked(window.localStorage.setItem)
    setItem.mockClear()
    useThemeStore.getState().setPreference('light')
    const call = setItem.mock.calls.find(([key]) => key === THEME_STORAGE_KEY)
    expect(call).toBeDefined()
    expect((await runInit(call?.[1] ?? null, true)).theme).toBe('kiro-light')
  })
})

describe('themeStore', () => {
  beforeEach(() => { useThemeStore.setState({ preference: 'system' }) })
  afterEach(() => { vi.restoreAllMocks() })

  it('cycles system → light → dark → system', () => {
    expect(nextPreference('system')).toBe('light')
    expect(nextPreference('light')).toBe('dark')
    expect(nextPreference('dark')).toBe('system')
    useThemeStore.getState().cyclePreference()
    expect(useThemeStore.getState().preference).toBe('light')
  })

  it('resolves system against the OS preference', () => {
    expect(resolveMode('system', true)).toBe('dark')
    expect(resolveMode('system', false)).toBe('light')
    expect(resolveMode('light', true)).toBe('light')
  })

  it('validates preferences', () => {
    expect(isThemePreference('dark')).toBe(true)
    expect(isThemePreference('neon')).toBe(false)
    expect(isThemePreference(1)).toBe(false)
  })

  it('applies attributes to <html>', () => {
    applyTheme('system', 'light')
    const data = document.documentElement.dataset
    expect(data.theme).toBe('kiro-light')
    expect(data.mode).toBe('light')
    expect(data.modePref).toBe('system')
  })
})
