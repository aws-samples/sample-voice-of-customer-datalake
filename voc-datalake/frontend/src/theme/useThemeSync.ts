/**
 * @fileoverview Keeps <html> theme attributes in step with the theme store
 * and, for the "system" preference, with the OS colour scheme.
 * Mount once at the app root.
 *
 * @module theme/useThemeSync
 */
import { useEffect, useSyncExternalStore } from 'react'
import { applyTheme, DARK_QUERY, resolveMode, systemPrefersDark, useThemeStore } from './themeStore'
import type { ThemeMode } from './themeStore'

function subscribeToSystemScheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(DARK_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** Resolved mode ('light' | 'dark'), reacting to OS changes under "system". */
function useResolvedThemeMode(): ThemeMode {
  const preference = useThemeStore((s) => s.preference)
  const prefersDark = useSyncExternalStore(subscribeToSystemScheme, systemPrefersDark, () => true)
  return resolveMode(preference, prefersDark)
}

export function useThemeSync(): void {
  const preference = useThemeStore((s) => s.preference)
  const mode = useResolvedThemeMode()
  useEffect(() => {
    applyTheme(preference, mode)
  }, [preference, mode])
}
