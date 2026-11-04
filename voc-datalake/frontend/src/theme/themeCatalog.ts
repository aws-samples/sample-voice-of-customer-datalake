/**
 * @fileoverview The colour themes the app ships (docs/kiro-design-system.md → Themes).
 *
 * A colour theme is a palette in two modes: index.css / styles/theme-palettes.css key
 * each one on `[data-theme="<id>-<mode>"]`. Which theme a person sees:
 * their own choice on /account, or `workspace` (the default) = the theme an
 * administrator picked for everyone (Administration → General, `GET
 * /settings/appearance`). The mode (light / dark / system) stays a separate,
 * personal preference (themeStore.ts).
 *
 * public/theme-init.js mirrors {@link COLOR_THEME_IDS} and {@link DEFAULT_COLOR_THEME}
 * (pinned by themeInit.test.ts); lambda/shared/appearance.py mirrors the ids
 * (pinned by its test).
 *
 * @module theme/themeCatalog
 */

export const COLOR_THEME_IDS = ['kiro', 'nord', 'dracula', 'highcontrast', 'quick'] as const

export type ColorThemeId = (typeof COLOR_THEME_IDS)[number]

/** The theme of a deployment whose administrator never picked one. */
export const DEFAULT_COLOR_THEME: ColorThemeId = 'kiro'

/** A person's choice that means "whatever the administrator picked for everyone". */
export const WORKSPACE_THEME_CHOICE = 'workspace'

export type ColorThemeChoice = ColorThemeId | typeof WORKSPACE_THEME_CHOICE

export type ThemeMode = 'light' | 'dark'

export function isColorThemeId(value: unknown): value is ColorThemeId {
  return typeof value === 'string' && COLOR_THEME_IDS.some((id) => id === value)
}

export function isColorThemeChoice(value: unknown): value is ColorThemeChoice {
  return value === WORKSPACE_THEME_CHOICE || isColorThemeId(value)
}

/** The theme a person sees: their own pick, or the workspace default. */
export function resolveColorTheme(choice: ColorThemeChoice, workspaceTheme: ColorThemeId): ColorThemeId {
  return choice === WORKSPACE_THEME_CHOICE ? workspaceTheme : choice
}

/** The `data-theme` value the stylesheets key a palette on. */
export function themeAttribute(theme: ColorThemeId, mode: ThemeMode): string {
  return `${theme}-${mode}`
}
