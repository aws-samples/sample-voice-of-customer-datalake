/**
 * @fileoverview Theme state (KiroCrew design system: Kiro dark / Kiro light).
 *
 * The user picks a preference (light | dark | system); the resolved mode is
 * applied to <html> as data attributes that index.css keys its tokens on.
 * public/theme-init.js applies the same attributes before first paint —
 * keep THEME_STORAGE_KEY and the attribute contract in sync with it
 * (pinned by themeInit.test.ts).
 *
 * @module theme/themeStore
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const THEME_STORAGE_KEY = 'voc-theme'
const THEME_PREFERENCES = ['system', 'light', 'dark'] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export type ThemeMode = 'light' | 'dark'

/**
 * Preference for a visitor who has never chosen one: Kiro Dark, whatever the OS
 * says. Mirrored by `DEFAULT_PREF` in public/theme-init.js (pinned by themeInit.test.ts).
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark'

export const DARK_QUERY = '(prefers-color-scheme: dark)'

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_PREFERENCES.some((p) => p === value)
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(DARK_QUERY).matches
}

export function resolveMode(preference: ThemePreference, prefersDark: boolean): ThemeMode {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

function themeAttribute(mode: ThemeMode): string {
  return `kiro-${mode}`
}

/** Write the theme attributes on <html>. */
export function applyTheme(preference: ThemePreference, mode: ThemeMode): void {
  const el = document.documentElement
  el.dataset.theme = themeAttribute(mode)
  el.dataset.mode = mode
  el.dataset.modePref = preference
}

/** Order used by the header toggle: system → light → dark → system. */
export function nextPreference(current: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(current)
  return THEME_PREFERENCES.at((index + 1) % THEME_PREFERENCES.length) ?? 'system'
}

interface ThemeState {
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
  cyclePreference: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      preference: DEFAULT_THEME_PREFERENCE,
      setPreference: (preference) => set({ preference }),
      cyclePreference: () => set({ preference: nextPreference(get().preference) }),
    }),
    {
      name: THEME_STORAGE_KEY,
      partialize: (state) => ({ preference: state.preference }),
      merge: (persisted, current) => {
        const candidate: unknown = typeof persisted === 'object' && persisted !== null
          ? Reflect.get(persisted, 'preference')
          : undefined
        return { ...current, preference: isThemePreference(candidate) ? candidate : current.preference }
      },
    },
  ),
)
