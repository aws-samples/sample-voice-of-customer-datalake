/**
 * @fileoverview Theme state: the colour theme (themeCatalog.ts) and the mode.
 *
 * The person picks a mode preference (light | dark | system) and a colour theme
 * (one of COLOR_THEME_IDS, or `workspace` = the administrator's default, cached
 * here as `workspaceTheme` so the next page load paints it before any request).
 * The resolved theme and mode are applied to <html> as data attributes that the
 * stylesheets key their tokens on. public/theme-init.js applies the same
 * attributes before first paint — keep THEME_STORAGE_KEY, the persisted shape
 * and the attribute contract in sync with it (pinned by themeInit.test.ts).
 *
 * @module theme/themeStore
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  DEFAULT_COLOR_THEME, isColorThemeChoice, isColorThemeId, themeAttribute, WORKSPACE_THEME_CHOICE,
} from './themeCatalog'
import type { ColorThemeChoice, ColorThemeId, ThemeMode } from './themeCatalog'

export const THEME_STORAGE_KEY = 'voc-theme'
const THEME_PREFERENCES = ['system', 'light', 'dark'] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]

/**
 * Preference for a visitor who has never chosen one: dark, whatever the OS
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

/** Write the theme attributes on <html>. */
export function applyTheme(preference: ThemePreference, mode: ThemeMode, theme: ColorThemeId): void {
  const el = document.documentElement
  el.dataset.theme = themeAttribute(theme, mode)
  el.dataset.colorTheme = theme
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
  /** The person's own colour theme, or `workspace` to follow the administrator's default. */
  colorTheme: ColorThemeChoice
  /** The administrator's default as last read from the API (GET /settings/appearance). */
  workspaceTheme: ColorThemeId
  cyclePreference: () => void
  setColorTheme: (choice: ColorThemeChoice) => void
  setWorkspaceTheme: (theme: ColorThemeId) => void
}

type PersistedTheme = Pick<ThemeState, 'preference' | 'colorTheme' | 'workspaceTheme'>

/** One persisted field, or the fallback when it is absent or not valid. */
function persistedField<T>(persisted: unknown, key: keyof PersistedTheme, valid: (v: unknown) => v is T, fallback: T): T {
  const candidate: unknown = typeof persisted === 'object' && persisted !== null ? Reflect.get(persisted, key) : undefined
  return valid(candidate) ? candidate : fallback
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      preference: DEFAULT_THEME_PREFERENCE,
      colorTheme: WORKSPACE_THEME_CHOICE,
      workspaceTheme: DEFAULT_COLOR_THEME,
      cyclePreference: () => set({ preference: nextPreference(get().preference) }),
      setColorTheme: (colorTheme) => set({ colorTheme }),
      setWorkspaceTheme: (workspaceTheme) => set({ workspaceTheme }),
    }),
    {
      name: THEME_STORAGE_KEY,
      partialize: (state): PersistedTheme => ({
        preference: state.preference, colorTheme: state.colorTheme, workspaceTheme: state.workspaceTheme,
      }),
      merge: (persisted, current) => ({
        ...current,
        preference: persistedField(persisted, 'preference', isThemePreference, current.preference),
        colorTheme: persistedField(persisted, 'colorTheme', isColorThemeChoice, current.colorTheme),
        workspaceTheme: persistedField(persisted, 'workspaceTheme', isColorThemeId, current.workspaceTheme),
      }),
    },
  ),
)
