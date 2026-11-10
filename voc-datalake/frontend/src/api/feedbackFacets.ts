/**
 * @fileoverview The one feedback facet model of the Dashboard, Categories and Problem Analysis.
 *
 * The four multi-value facets — `source`, `category`, `sentiment`, `usefulness` — are spelled the
 * same in the page URL and in the API query string (`shared/item_facets.py` on the server): one
 * value, or a comma-separated list meaning ANY of them. A filtered page is therefore a shareable
 * link, and the server answers exactly what the page shows (no browser-side refinement of a
 * capped page). Every page parses and writes these keys through this module, so they cannot
 * drift. Ported from PR #429's `feedbackFilters.ts` (@aws-bryan), fitted to main's pages.
 *
 * `usefulness=unrated` is the explicit value for a review stored without a band; it is never
 * implied by the bands.
 *
 * @module api/feedbackFacets
 */

export const SENTIMENT_FACET_VALUES = ['positive', 'neutral', 'negative', 'mixed'] as const
export type SentimentFacet = (typeof SENTIMENT_FACET_VALUES)[number]

/** The stored usefulness bands, best first (`shared/usefulness.py`). */
export const USEFULNESS_BANDS = ['high', 'medium', 'low'] as const
export type UsefulnessBand = (typeof USEFULNESS_BANDS)[number]
/** The filter value for a review without a stored band. Never stored. */
const USEFULNESS_UNRATED = 'unrated'
export const USEFULNESS_FACET_VALUES = [...USEFULNESS_BANDS, USEFULNESS_UNRATED] as const
export type UsefulnessFacet = (typeof USEFULNESS_FACET_VALUES)[number]

/** The server's per-facet bound (`MAX_FACET_VALUES`): longer lists are a 400, so the URL is cut to it. */
export const MAX_FACET_VALUES = 50

export interface FeedbackFacets {
  readonly sources: readonly string[]
  readonly categories: readonly string[]
  readonly sentiments: readonly SentimentFacet[]
  readonly usefulness: readonly UsefulnessFacet[]
}

export type FacetName = keyof FeedbackFacets

export const EMPTY_FACETS: FeedbackFacets = Object.freeze({ sources: [], categories: [], sentiments: [], usefulness: [] })

/** Each facet's query key, in the order they are written. */
export const FACET_PARAMS: Readonly<Record<FacetName, string>> = Object.freeze({
  sources: 'source',
  categories: 'category',
  sentiments: 'sentiment',
  usefulness: 'usefulness',
})

const FACET_NAMES: readonly FacetName[] = ['sources', 'categories', 'sentiments', 'usefulness']

/** The query params of the facets, for an API call (absent = any). */
export interface FacetQueryParams {
  source?: string
  category?: string
  sentiment?: string
  usefulness?: string
}

function isSentimentFacet(value: string): value is SentimentFacet {
  return SENTIMENT_FACET_VALUES.some((known) => known === value)
}

function isUsefulnessFacet(value: string): value is UsefulnessFacet {
  return USEFULNESS_FACET_VALUES.some((known) => known === value)
}

export function isUsefulnessBand(value: unknown): value is UsefulnessBand {
  return USEFULNESS_BANDS.some((known) => known === value)
}

/** A comma list's values: trimmed, empty parts and repeats dropped, at most {@link MAX_FACET_VALUES}. */
export function parseListParam(value: string | null): string[] {
  if (value === null || value === '') return []
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
  return [...new Set(parts)].slice(0, MAX_FACET_VALUES)
}

/** The facets a URL (or any query string) says; unknown sentiment / usefulness values are dropped. */
export function readFacets(params: URLSearchParams): FeedbackFacets {
  return {
    sources: parseListParam(params.get(FACET_PARAMS.sources)),
    categories: parseListParam(params.get(FACET_PARAMS.categories)),
    sentiments: parseListParam(params.get(FACET_PARAMS.sentiments)).filter(isSentimentFacet),
    usefulness: parseListParam(params.get(FACET_PARAMS.usefulness)).filter(isUsefulnessFacet),
  }
}

/** `[key, 'a,b']` for every set facet, in {@link FACET_PARAMS} order (for a URL or a request). */
export function facetEntries(facets: FeedbackFacets): [string, string][] {
  return FACET_NAMES
    .filter((name) => facets[name].length > 0)
    .map((name) => [FACET_PARAMS[name], facets[name].join(',')])
}

/** The API query params of the facets (unset facets absent). */
export function facetQueryParams(facets: FeedbackFacets): FacetQueryParams {
  return Object.fromEntries(facetEntries(facets))
}

/** `list` with `value` added, or removed when present (selection order kept). */
export function toggleFacetValue<T extends string>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

/** How many facets narrow the view (a multi-value facet counts once). */
export function countActiveFacets(facets: FeedbackFacets): number {
  return FACET_NAMES.filter((name) => facets[name].length > 0).length
}

export function hasActiveFacets(facets: FeedbackFacets): boolean {
  return countActiveFacets(facets) > 0
}

/** A stable form for query keys: selection order ignored, so `a,b` and `b,a` share one cache entry. */
export function facetsKey(facets: FeedbackFacets): string {
  const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b)).join(',')
  return FACET_NAMES.map((name) => `${FACET_PARAMS[name]}=${sorted(facets[name])}`).join('&')
}
