/**
 * @fileoverview A form theme's contrast, by the one set of rules the editor, the server
 * (lambda/shared/form_theme.py) and the widget share (audit §2.3, WCAG 2), for every palette that can be shown:
 *
 * | Pair | Minimum | Below it |
 * |---|---|---|
 * | Text on background | 4.5:1 | under 3:1 an error that blocks Publish and a live form's colour change; from 3 a warning |
 * | Primary on background (focus ring, progress, selected edge) | 3:1 | a warning |
 * | Button label on primary (`readableOn`: white or #19161d) | 4.5:1 | a warning |
 * | Option edge (the text at 55 % over the background, raised until 3:1) | 3:1 | a warning (derived) |
 *
 * A live form kept on the theme it already has (saved before 7.55.01 with unreadable text) is only warned about
 * ({@link keptLiveTheme}), as the server (shared/forms_v2.py `validate_publishable`) only warns: its other edits go
 * through, a colour change must be readable.
 *
 * A suggestion moves a colour in OKLCH lightness only, keeping its hue and chroma (the design system's "AA
 * adjustments"): the nearest darker and the nearest lighter value that pass (`/tmp/forms-ux-audit/scripts/oklch.mjs`).
 *
 * @module pages/FeedbackForms/theme/contrast
 */
import type { FormTheme, FormV2, ThemePalette } from '../model/formsV2'

/** Whether two themes draw the same form: every field alike, whatever their key order (forms_v2.py `same_theme`). */
function sameTheme(a: FormTheme, b: FormTheme): boolean {
  const palette = (x: ThemePalette, y: ThemePalette) =>
    x.primary_color === y.primary_color && x.background_color === y.background_color && x.text_color === y.text_color
  return palette(a, b) && palette(a.dark, b.dark) && a.border_radius === b.border_radius && a.mode === b.mode
    && a.font === b.font && a.text_size === b.text_size
}

/** The theme a stored form that is live already has (undefined for a new form, or one that is Off): the theme whose
 * unreadable text is only a warning while it is kept. */
export const liveThemeOf = (baseline: FormV2 | null, stored: boolean): FormTheme | undefined =>
  (stored && baseline?.enabled === true ? baseline.theme : undefined)

/** Is `theme` the live form's own, kept as it is (so unreadable text warns rather than blocks)? */
export const keptLiveTheme = (theme: FormTheme, liveTheme: FormTheme | undefined): boolean =>
  liveTheme !== undefined && sameTheme(theme, liveTheme)

const TEXT_MINIMUM = 4.5
/** Text under this on its background can't be published (form_theme.py TEXT_PUBLISH_MINIMUM). */
const TEXT_PUBLISH_MINIMUM = 3
const CONTROL_MINIMUM = 3
/** The widget's dark label colour, the other choice of {@link readableOn}. */
const DARK_LABEL = '#19161d'
const WHITE = '#ffffff'
/** The option edge's alphas, tried in turn: 55 % of the text, then 5 % more at a time, up to the text itself. */
const EDGE_ALPHAS: readonly number[] = [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1]

/** A colour the editor writes: `#rgb` or `#rrggbb`. */
const EDITOR_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
/** A colour a stored form may hold: also an old form's `#rrggbbaa` (judged composited). */
const STORED_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Is `value` a colour the hex field accepts (`#rgb`, `#rrggbb`)? */
export const isEditorHex = (value: string): boolean => EDITOR_HEX.test(value.trim())

type Rgb = readonly [number, number, number]

/** The 0–1 channels and the alpha of a hex colour, or null when it is not one. */
function rgba(colour: string): { readonly rgb: Rgb; readonly alpha: number } | null {
  const value = colour.trim()
  if (!STORED_HEX.test(value)) return null
  const digits = value.length === 4 ? value.slice(1).replace(/./g, '$&$&') : value.slice(1)
  const at = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16) / 255
  return { rgb: [at(0), at(2), at(4)], alpha: digits.length === 8 ? at(6) : 1 }
}

/** `top` at `alpha` over the opaque `bottom` (sRGB, as a browser mixes). */
const over = (top: Rgb, alpha: number, bottom: Rgb): Rgb =>
  [top[0] * alpha + bottom[0] * (1 - alpha), top[1] * alpha + bottom[1] * (1 - alpha), top[2] * alpha + bottom[2] * (1 - alpha)]

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = (rgb: Rgb): number => 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2])

function ratioOf(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

/** A background as painted: an old translucent one over white (the API's own page). */
function painted(background: string): Rgb | null {
  const bg = rgba(background)
  return bg === null ? null : over(bg.rgb, bg.alpha, [1, 1, 1])
}

/** The WCAG 2 contrast of `foreground` on `background` (1–21), or null when either is not a hex colour. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = rgba(foreground)
  const bg = painted(background)
  if (fg === null || bg === null) return null
  return ratioOf(over(fg.rgb, fg.alpha, bg), bg)
}

/** The label colour on `fill` (the widget's buttons): white or #19161d, whichever contrasts more (white on a tie). */
export function readableOn(fill: string): string {
  const white = contrastRatio(WHITE, fill)
  if (white === null) return WHITE
  return white >= (contrastRatio(DARK_LABEL, fill) ?? 0) ? WHITE : DARK_LABEL
}

/** The option edge the widget draws: the text colour at 55 % over the background, raised in 5 % steps until 3:1. */
export function optionEdge(text: string, background: string): { readonly alpha: number; readonly ratio: number } | null {
  const fg = rgba(text)
  const bg = painted(background)
  if (fg === null || bg === null) return null
  const steps = EDGE_ALPHAS.map((alpha) => ({ alpha, ratio: ratioOf(over(fg.rgb, alpha, bg), bg) }))
  return steps.find((step) => step.ratio >= CONTROL_MINIMUM) ?? steps[steps.length - 1] ?? null
}

// ── The four pairs ───────────────────────────────────────────────────────────────────────────────────────────────

export type PaletteName = 'light' | 'dark'
export type PairId = 'text' | 'primary' | 'label' | 'edge'
/** ok: meets its minimum; warn: below it; error: text under 3:1, which blocks Publish. */
export type PairLevel = 'ok' | 'warn' | 'error'
/** The colour of the palette a pair's suggestion changes (the label and the edge follow the primary and the text). */
export type PaletteColour = keyof ThemePalette

export interface ContrastPair {
  readonly id: PairId
  /** null: a colour is not hex (not judged). */
  readonly ratio: number | null
  readonly minimum: number
  readonly level: PairLevel
  /** The colour a suggestion moves, and the colour it is judged against. */
  readonly colour: PaletteColour
}

function levelOf(ratio: number | null, minimum: number, publishMinimum?: number): PairLevel {
  if (ratio === null || ratio >= minimum) return ratio === null ? 'warn' : 'ok'
  return publishMinimum !== undefined && ratio < publishMinimum ? 'error' : 'warn'
}

/** The label pair's ratio: the better of white and #19161d on the primary. */
const labelRatio = (primary: string): number | null => {
  const label = readableOn(primary)
  return contrastRatio(label, primary)
}

/** The four pairs of one palette, in the editor's order. */
export function palettePairs(palette: ThemePalette): readonly ContrastPair[] {
  const text = contrastRatio(palette.text_color, palette.background_color)
  const primary = contrastRatio(palette.primary_color, palette.background_color)
  const label = labelRatio(palette.primary_color)
  const edge = optionEdge(palette.text_color, palette.background_color)
  return [
    { id: 'text', ratio: text, minimum: TEXT_MINIMUM, level: levelOf(text, TEXT_MINIMUM, TEXT_PUBLISH_MINIMUM), colour: 'text_color' },
    { id: 'primary', ratio: primary, minimum: CONTROL_MINIMUM, level: levelOf(primary, CONTROL_MINIMUM), colour: 'primary_color' },
    { id: 'label', ratio: label, minimum: TEXT_MINIMUM, level: levelOf(label, TEXT_MINIMUM), colour: 'primary_color' },
    {
      id: 'edge', ratio: edge?.ratio ?? null, minimum: CONTROL_MINIMUM, level: levelOf(edge?.ratio ?? null, CONTROL_MINIMUM),
      colour: 'text_color',
    },
  ]
}

/** The id of the editor's note about `pair` (the colour fields are described by it). */
export const contrastNoteId = (base: string, pair: PairId): string => `${base}-contrast-${pair}`

/** The notes about one colour of a palette (its pairs below their minimum): the ids its field is described by. */
export function notesAbout(base: string, pairs: readonly ContrastPair[], colour: PaletteColour): string | undefined {
  const ids = pairs.filter((pair) => pair.colour === colour && pair.level !== 'ok' && pair.id !== 'edge').map((pair) => contrastNoteId(base, pair.id))
  return ids.length === 0 ? undefined : ids.join(' ')
}

/** The palettes respondents can be shown: light for mode light, dark for mode dark, both for auto. */
export function shownPalettes(theme: Pick<FormTheme, 'mode'>): readonly PaletteName[] {
  if (theme.mode === 'light') return ['light']
  if (theme.mode === 'dark') return ['dark']
  return ['light', 'dark']
}

/** One palette of the theme by name. */
export function paletteOf(theme: FormTheme, name: PaletteName): ThemePalette {
  if (name === 'dark') return theme.dark
  return { primary_color: theme.primary_color, background_color: theme.background_color, text_color: theme.text_color }
}

/** The palettes whose text is under 3:1 on their background, with the ratio: what blocks Publish. */
export function unreadablePalettes(theme: FormTheme): readonly { readonly palette: PaletteName; readonly ratio: number }[] {
  return shownPalettes(theme).flatMap((palette) => {
    const ratio = contrastRatio(paletteOf(theme, palette).text_color, paletteOf(theme, palette).background_color)
    return ratio !== null && ratio < TEXT_PUBLISH_MINIMUM ? [{ palette, ratio }] : []
  })
}

// ── OKLCH-lightness suggestions ──────────────────────────────────────────────────────────────────────────────────

const toSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function toOklch(rgb: Rgb): readonly [number, number, number] {
  const [r, g, b] = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [lightness, Math.hypot(a, bb), Math.atan2(bb, a)]
}

function fromOklch(lightness: number, chroma: number, hue: number): Rgb {
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

const hexOf = (rgb: Rgb): string =>
  `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}`

/** The colour at `lightness`, its chroma reduced (by 5 % steps) until it is inside sRGB. */
function inGamut(lightness: number, chroma: number, hue: number): string {
  const rgb = fromOklch(lightness, chroma, hue)
  if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4) || chroma < 0.002) return hexOf(rgb)
  return inGamut(lightness, chroma * 0.95, hue)
}

export interface Suggestion {
  readonly colour: string
  readonly ratio: number
}

const LIGHTNESS_STEP = 0.005
/** 200 steps of 0.005: the whole of OKLCH lightness either way. */
const STEPS: readonly number[] = Array.from({ length: 200 }, (_, index) => (index + 1) * LIGHTNESS_STEP)

/** The first value `direction`-ward of `lightness` (hue and chroma kept) whose ratio reaches `minimum`. */
function nearest(start: readonly [number, number, number], direction: -1 | 1, minimum: number,
  ratioFor: (candidate: string) => number | null): Suggestion | null {
  const [lightness, chroma, hue] = start
  const levels = STEPS.map((step) => lightness + direction * step).filter((level) => level >= 0 && level <= 1)
  for (const level of levels) {
    const colour = inGamut(level, chroma, hue)
    const ratio = ratioFor(colour)
    if (ratio !== null && ratio >= minimum) return { colour, ratio }
  }
  return null
}

/**
 * The nearest darker and the nearest lighter value of `colour` (moved in OKLCH lightness only) whose `ratioFor`
 * reaches `minimum`; either is absent when no value that way does. A colour that already passes needs none.
 */
export function suggestColours(colour: string, minimum: number, ratioFor: (candidate: string) => number | null): { readonly darker?: Suggestion; readonly lighter?: Suggestion } {
  const parsed = rgba(colour)
  if (parsed === null) return {}
  const start = toOklch(parsed.rgb)
  const darker = nearest(start, -1, minimum, ratioFor)
  const lighter = nearest(start, 1, minimum, ratioFor)
  return { ...(darker === null ? {} : { darker }), ...(lighter === null ? {} : { lighter }) }
}

/** The suggestions that fix one failing pair of a palette (none for a pair that passes, or the derived edge). */
export function pairSuggestions(pair: ContrastPair, palette: ThemePalette): readonly Suggestion[] {
  if (pair.level === 'ok' || pair.id === 'edge') return []
  const background = palette.background_color
  const ratioFor = pair.id === 'label' ? labelRatio : (candidate: string) => contrastRatio(candidate, background)
  const { darker, lighter } = suggestColours(palette[pair.colour], pair.minimum, ratioFor)
  return [darker, lighter].filter((found): found is Suggestion => found !== undefined)
}
