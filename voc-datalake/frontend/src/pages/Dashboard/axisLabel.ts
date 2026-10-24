/**
 * @fileoverview Fitting a category label into a chart axis of known width
 * (CategoryAxisTick). Split from the component so that file only exports
 * components (react-refresh/only-export-components).
 * @module pages/Dashboard/axisLabel
 */

/** Average glyph width of the 12px axis font, rounded up so the estimate errs short. */
const CHAR_WIDTH_PX = 7
/** The gap between a tick label and its tick line. */
export const TICK_GAP_PX = 6
/** Never cut a label below this many characters, however narrow the axis. */
const MIN_CHARS = 4

/** How many characters fit in an axis `width` px wide. */
export function charsThatFit(width: number): number {
  return Math.max(MIN_CHARS, Math.floor((width - TICK_GAP_PX) / CHAR_WIDTH_PX))
}

/** `label` cut to `maxChars` with a trailing ellipsis (unchanged when it fits). */
export function truncateLabel(label: string, maxChars: number): string {
  if (label.length <= maxChars) return label
  return `${label.slice(0, maxChars - 1).trimEnd()}…`
}

const THOUSAND = 1_000
const MILLION = 1_000_000
/** The thousands abbreviation of a locale whose compact form has none (by base language). */
const THOUSANDS_ABBREVIATION: Readonly<Record<string, string>> = { de: 'Tsd.' }

/**
 * A number-tick formatter in compact notation for `locale` (`10000` → `10K`,
 * `1500000` → `1.5M`, `950` → `950`), so a 5-digit count never needs a
 * 5-character axis. Non-numbers render as text. Build it once per chart, not per tick.
 *
 * Some locales' CLDR "short" compact form does not abbreviate thousands at all
 * (German: `10000` → `10.000`, `7500` → `7500`, first abbreviation at a million),
 * which put 6-character ticks on the axes (verify4 V4). For those the thousands
 * get the locale's usual abbreviation (`10 Tsd.`, `7,5 Tsd.`), `K` when none is listed.
 */
export function compactFormatter(locale = 'en'): (value: unknown) => string {
  const format = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const thousands = abbreviatesThousands(format) ? null : thousandsFormatter(locale)
  return (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '')
    if (thousands !== null && Math.abs(value) >= THOUSAND && Math.abs(value) < MILLION) return thousands(value)
    return format.format(value)
  }
}

/** True when the locale's compact form shortens 10,000 (`10K`, `10 mil`, `1万`), false when it prints it whole. */
function abbreviatesThousands(format: Intl.NumberFormat): boolean {
  return /[^\d\s.,']/u.test(format.format(10 * THOUSAND))
}

/** `7500` → `7,5 Tsd.`: the value in thousands, in the locale's digits, with its abbreviation. */
function thousandsFormatter(locale: string): (value: number) => string {
  const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  const base = locale.split('-')[0] ?? locale
  const suffix = THOUSANDS_ABBREVIATION[base] ?? 'K'
  return (value) => `${plain.format(value / THOUSAND)}\u00a0${suffix}`
}

/**
 * Number Y axes measure their own ticks (`<YAxis width="auto">`, Recharts 3): the
 * rendered label width in the axis font, so no locale's tick is cut at the left
 * edge (verify4 V4: German "10.000" lost its first digits in an estimated width).
 */
export const NUMBER_AXIS_WIDTH = 'auto'

/** Category axis bounds: never narrower than a short label, never wider than a third of a phone-width card. */
const MIN_CATEGORY_AXIS_PX = 48
export const MAX_CATEGORY_AXIS_PX = 128

/**
 * The width a category axis needs for `labels`, clamped to
 * [48, `maxWidth`] px; a longer label is cut with an ellipsis by
 * CategoryAxisTick (full label in its tooltip).
 */
export function categoryAxisWidth(labels: readonly string[], maxWidth = MAX_CATEGORY_AXIS_PX): number {
  const longest = Math.max(0, ...labels.map((label) => label.length))
  return Math.min(maxWidth, Math.max(MIN_CATEGORY_AXIS_PX, longest * CHAR_WIDTH_PX + TICK_GAP_PX))
}

/** Height per bar row in a horizontal bar chart, and the room its number axis takes. */
const BAR_ROW_PX = 30
const BAR_AXIS_PX = 40
const MIN_BAR_CHART_PX = 200

/** A horizontal bar chart's height for `rows` bars, so each label keeps a readable row. */
export function barChartHeight(rows: number): number {
  return Math.max(MIN_BAR_CHART_PX, rows * BAR_ROW_PX + BAR_AXIS_PX)
}

/** −1 … +1 sentiment ticks in the locale ("−0.5", "−0,5"; a real minus sign). */
export function sentimentTickFormatter(locale: string): (value: unknown) => string {
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  return (value) => (typeof value === 'number' ? format.format(value).replace('-', '\u2212') : String(value))
}
