/**
 * @fileoverview The colour theme the person sees right now: their own pick, or
 * the workspace default (themeCatalog.ts).
 * @module theme/useActiveColorTheme
 */
import { resolveColorTheme } from './themeCatalog'
import { useThemeStore } from './themeStore'
import type { ColorThemeId } from './themeCatalog'

export function useActiveColorTheme(): ColorThemeId {
  return useThemeStore((s) => resolveColorTheme(s.colorTheme, s.workspaceTheme))
}
