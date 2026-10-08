import type { TFunction } from 'i18next'

export type ViewMode = 'grid' | 'list'
export type SentimentFilter = 'all' | 'positive' | 'negative' | 'neutral' | 'mixed'

/** Direction of the star-rating filter: at least N stars, or at most N stars. */
export type RatingDirection = 'up' | 'below'

/** Star-rating filter. `value` 0 means "any rating" (direction is inert). */
export interface RatingFilter {
  /** 1-5 star threshold; 0 = any rating. */
  value: number
  /** 'up' = value or more stars; 'below' = value or fewer stars. */
  direction: RatingDirection
}

export const ANY_RATING_FILTER: Readonly<RatingFilter> = Object.freeze({ value: 0, direction: 'up' as const })

/**
 * True when an item's star rating passes the filter. Unrated items are
 * excluded in BOTH directions once a threshold is set — "3 stars and below"
 * implies the item was rated, mirroring how "3+ stars" always behaved.
 */
export function matchesRatingFilter(rating: number | undefined, filter: RatingFilter): boolean {
  if (filter.value === 0) return true
  if (!rating) return false
  return filter.direction === 'up' ? rating >= filter.value : rating <= filter.value
}

/**
 * Compact localized label for active-filter summaries, e.g. "3+ stars" /
 * "≤3 stars". Keys are namespace-prefixed so any `t` works as long as the
 * `categories` namespace is loaded.
 */
export function ratingFilterLabel(filter: RatingFilter, t: TFunction): string {
  return filter.direction === 'up'
    ? t('categories:starsMin', { count: filter.value })
    : t('categories:starsMaxShort', { count: filter.value })
}

export interface CategoryData {
  name: string
  value: number
  /** Print/PDF hex of the category's ramp step. On-screen UI paints `chartStepVar` of `categoryChartSteps(ranked names)` instead. */
  color: string
}

export interface SentimentData {
  name: string
  value: number
  /** Print/PDF hex (see `sentimentHexColor`). On-screen UI uses `sentimentCssVar(name)` instead. */
  color: string
  percentage: number
  [key: string]: string | number
}

export interface WordCloudItem {
  word: string
  count: number
}

/**
 * Category DATA colours come from the design-system ramp (`--chart-1…8` in
 * `src/index.css`), never from a hue per category: the ramp is KiroCrew's
 * categorical data hues (`--ctx-src-*`: accent, blue, teal, orange, violet,
 * green, amber) plus the neutral grey.
 *
 * Names from the shipped taxonomies keep a FIXED step, so `delivery` is the same
 * colour on every page and reload. Every other name — and on production every
 * category is a custom name (design audit D-14: all eight bars were the neutral
 * grey) — takes the next chromatic step not already used in the list, IN RANK
 * ORDER (the list's own order, largest first). The same ordered list therefore
 * always gets the same colours. `other`, and any name once the seven chromatic
 * steps are spent, is the neutral step. Colour is never the only cue: every bar
 * sits next to its name and count.
 */
/** `--chart-6` is `--muted` in both themes. */
export const NEUTRAL_CHART_STEP = 6
const CHROMATIC_STEPS: readonly number[] = [1, 2, 3, 4, 5, 7, 8]

const CATEGORY_FAMILIES: ReadonlyArray<readonly string[]> = [
  // Airline taxonomy
  ['flight_operations', 'in_flight_experience', 'customer_service', 'baggage_handling', 'booking_and_check_in', 'pricing_and_fees', 'loyalty_program', 'airport_facilities'],
  // Generic taxonomy
  ['delivery', 'customer_support', 'product_quality', 'pricing', 'website', 'app', 'billing', 'returns', 'communication'],
]

function buildTaxonomySteps(): ReadonlyMap<string, number> {
  const steps = new Map<string, number>()
  for (const family of CATEGORY_FAMILIES) {
    family.forEach((name, i) => steps.set(name, CHROMATIC_STEPS.at(i % CHROMATIC_STEPS.length) ?? NEUTRAL_CHART_STEP))
  }
  steps.set('other', NEUTRAL_CHART_STEP)
  return steps
}

const TAXONOMY_STEPS = buildTaxonomySteps()

/**
 * The ramp step of every category in `rankedNames` (largest first): taxonomy
 * names keep their fixed step, the rest take the unused chromatic steps by rank.
 */
export function categoryChartSteps(rankedNames: readonly string[]): ReadonlyMap<string, number> {
  const unique = [...new Set(rankedNames)]
  const taken = new Set(unique.map((name) => TAXONOMY_STEPS.get(name)).filter((step) => step !== undefined))
  const free = CHROMATIC_STEPS.filter((step) => !taken.has(step))
  const customRank = new Map(unique.filter((name) => !TAXONOMY_STEPS.has(name)).map((name, rank) => [name, rank]))
  return new Map(unique.map((name) => [
    name,
    TAXONOMY_STEPS.get(name) ?? free.at(customRank.get(name) ?? free.length) ?? NEUTRAL_CHART_STEP,
  ]))
}

/** Theme-aware CSS colour (`var(--chart-N)`) for a ramp step, for on-screen bars, swatches and SVG. */
export function chartStepVar(step: number): string {
  return `var(--chart-${step})`
}

/** `--chart-6` (the neutral step) in Kiro Light, for print/PDF. */
const NEUTRAL_PRINT_HEX = '#5e5966'

/**
 * Kiro Light `--chart-1…8`, mirrored for the print/PDF export ONLY: it renders
 * into a window without the app stylesheet (so `var(--…)` cannot resolve) and
 * paper stays light whatever the on-screen theme. `types.test.ts` pins these
 * to the `[data-theme="kiro-light"]` block of `src/index.css`.
 */
const CHART_RAMP_PRINT_HEX: readonly string[] = [
  '#8e48ff', '#4194e0', '#359f95', '#c97c49', '#a37be0', NEUTRAL_PRINT_HEX, '#00a377', '#ae8b38',
]

/** Literal hex for a ramp step. Print/PDF renderers only. */
export function chartStepPrintHex(step: number): string {
  return CHART_RAMP_PRINT_HEX.at(step - 1) ?? NEUTRAL_PRINT_HEX
}

export function getSentimentScoreColorClass(score: number): string {
  if (score > 20) return 'text-sentiment-positive'
  if (score < -20) return 'text-sentiment-negative'
  return 'text-text'
}

