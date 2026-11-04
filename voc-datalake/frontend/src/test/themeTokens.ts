/**
 * Theme tokens read straight from index.css (Kiro) and styles/theme-palettes.css
 * (every other colour theme), and WCAG contrast between them, for the
 * design-system residue tests (theme/*.test.ts).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COLOR_THEME_IDS, type ColorThemeId, type ThemeMode } from '../theme/themeCatalog'

export const indexCss = readFileSync(resolve(__dirname, '../index.css'), 'utf8')
export const paletteCss = readFileSync(resolve(__dirname, '../styles/theme-palettes.css'), 'utf8')
/** Both stylesheets: index.css (recipes + the Kiro blocks), then every other theme's blocks. */
export const themeCss = `${indexCss}\n${paletteCss}`

export type Theme = `${ColorThemeId}-${ThemeMode}`
const MODES: readonly ThemeMode[] = ['dark', 'light']

/** Every `data-theme` block the app ships: each colour theme in both modes. */
export const THEMES: readonly Theme[] = COLOR_THEME_IDS.flatMap((id) => MODES.map((mode): Theme => `${id}-${mode}`))

/** The Kiro blocks, for checks about Kiro's own provenance (KiroCrew values, the audit's measurements). */
export const KIRO_THEMES = ['kiro-dark', 'kiro-light'] as const
export type KiroTheme = (typeof KIRO_THEMES)[number]

/** The Kiro block of `mode`: the reference every other theme's token set is held to. */
export function kiroThemeOf(mode: ThemeMode): KiroTheme {
  return mode === 'dark' ? 'kiro-dark' : 'kiro-light'
}

/** The mode a theme block paints. */
export function modeOf(theme: Theme): ThemeMode {
  return theme.endsWith('-dark') ? 'dark' : 'light'
}

/** The colour theme a block belongs to (`nord-light` → `nord`). */
export function colorThemeOf(theme: Theme): ColorThemeId {
  const id = COLOR_THEME_IDS.find((candidate) => theme.startsWith(`${candidate}-`))
  if (id === undefined) throw new Error(`no colour theme for ${theme}`)
  return id
}

/** The blocks of one colour theme. */
export function themesOf(id: ColorThemeId): Theme[] {
  return THEMES.filter((theme) => colorThemeOf(theme) === id)
}


/** `css` without its block comments (split on the delimiters; no backtracking regex). */
export function withoutComments(css: string): string {
  const [head = '', ...rest] = css.split('/*')
  return head + rest.map((part) => {
    const close = part.indexOf('*/')
    return close === -1 ? '' : part.slice(close + 2)
  }).join('')
}

/** The declarations of the first rule in `css` whose selector list starts with `selector`. */
export function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`no rule for ${selector}`)
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
}

/** Both stylesheets without comments, so a comment naming a selector never matches ahead of the real block. */
const themeCssCode = withoutComments(themeCss)

/** The declarations of one `[data-theme="…"]` block. */
export function themeBlockBody(theme: Theme): string {
  const start = themeCssCode.indexOf(`[data-theme="${theme}"] {`)
  if (start === -1) throw new Error(`no ${theme} block`)
  return themeCssCode.slice(themeCssCode.indexOf('{', start) + 1, themeCssCode.indexOf('}', start))
}

/** Every custom property one theme block declares (`--name` without the dashes), sorted. */
export function themeTokenNames(theme: Theme): string[] {
  return themeBlockBody(theme).split(';')
    .map((declaration) => declaration.slice(0, declaration.indexOf(':')).trim())
    .filter((name) => name.startsWith('--'))
    .map((name) => name.slice(2))
    .sort((a, b) => a.localeCompare(b))
}

/** `--name: #hex` declarations of one `[data-theme="…"]` block, lower-cased. */
export function themeHexTokens(theme: Theme): Record<string, string> {
  const body = themeBlockBody(theme)
  const found: Record<string, string> = {}
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':')
    const name = declaration.slice(0, colon).trim()
    const value = declaration.slice(colon + 1).trim().toLowerCase()
    if (colon > 0 && name.startsWith('--') && /^#[0-9a-f]{6}$/.test(value)) found[name.slice(2)] = value
  }
  return found
}

/** One token's hex in `theme`; throws when the block does not declare it as a hex. */
export function themeHex(theme: Theme, name: string): string {
  const hex = themeHexTokens(theme)[name]
  if (hex === undefined) throw new Error(`--${name} has no hex value in ${theme}`)
  return hex
}

function relativeLuminance(hex: string): number {
  const channel = (offset: number): number => {
    const v = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function channels(hex: string): [number, number, number] {
  const byte = (offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16)
  return [byte(1), byte(3), byte(5)]
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

/** `color-mix(in srgb, fg <weight>, bg)` as `#rrggbb` (KiroCrew's `--ctx-src-*` recipe). */
export function mixHex(fg: string, bg: string, weight: number): string {
  const back = channels(bg)
  return toHex(channels(fg).map((c, i) => c * weight + (back[i] ?? 0) * (1 - weight)))
}

/** HSL hue of `#rrggbb` in degrees (0–360); a grey answers 0. */
export function hueOf(hex: string): number {
  const [r255, g255, b255] = channels(hex)
  const [r, g, b] = [r255 / 255, g255 / 255, b255 / 255]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  return (hueSector(r, g, b, max, d) * 60 + 360) % 360
}

/** The 60° sector (fractional) of the HSL hue, from the dominant channel. */
function hueSector(r: number, g: number, b: number, max: number, d: number): number {
  if (max === r) return ((g - b) / d) % 6
  if (max === g) return (b - r) / d + 2
  return (r - g) / d + 4
}

/** Distance between two hues on the colour wheel, in degrees (0–180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/**
 * A `--name: rgba(r, g, b, a)` token of one theme block painted over `bg`, as the
 * opaque `#rrggbb` the eye sees (how a `bg-*-subtle` tint lands on a card).
 */
export function themeRgbaOver(theme: Theme, name: string, bg: string): string {
  const body = themeBlockBody(theme)
  const m = new RegExp(`--${name}:\\s*rgba\\(\\s*(\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\s*\\)`).exec(body)
  if (m === null) throw new Error(`--${name} has no rgba() value in ${theme}`)
  const [, r = '0', g = '0', b = '0', a = '0'] = m
  return mixHex(toHex([Number(r), Number(g), Number(b)]), bg, Number(a))
}
