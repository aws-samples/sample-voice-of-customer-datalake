/**
 * @fileoverview URL-synced filter state for the Categories page.
 *
 * Owns every user-adjustable feedback filter and mirrors the shareable
 * subset (q / source / sentiment / category / usefulness / subcategory / rating / urgent / channel / dims / tag /
 * types) to the URL so links are
 * shareable and FeedbackDetail tag-clicks can deep-link into a pre-filtered
 * Categories view. The facets (source, category, sentiment, usefulness) are read and
 * written by `api/feedbackFacets.ts`, the Dashboard's and Problem Analysis' model: a comma
 * list (`?category=a,b`) means any of them, and the server filters it exactly.
 *
 * Review types (`types`, `components/ReviewTypeFilter/reviewTypeSelection.ts`) are the pills above the
 * other attribute filters: absent = every type (this page's default), and they reach the server inside
 * `dims` (`feedback_type:a|b|~unset`) next to the configured dimensions. An old link's
 * `dims=feedback_type:<value>` (the single-value select this replaced) opens as that one pill.
 *
 * The default state (nothing selected) browses ALL feedback — there is no
 * separate "All" toggle. Selecting categories narrows the list; deselecting
 * everything returns to the browse-all view (issue #198 UX rationalization).
 *
 * @module pages/Categories/useCategoryFilters
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { parseDims, serializeDims } from '../../api/dimensionsSchema'
import { EMPTY_FACETS, FACET_PARAMS, facetEntries, readFacets, toggleFacetValue } from '../../api/feedbackFacets'
import type { FacetName, FeedbackFacets, SentimentFacet, UsefulnessFacet } from '../../api/feedbackFacets'
import type { AttributeFilters, ItemFilterParams } from '../../api/types'
import { withOwnedParams } from '../../utils/searchParams'
import { FEEDBACK_TYPE_KEY } from '../../api/feedbackTypes'
import {
  ALL_TYPES, readTypeSelection, typeSelectionDims, writeTypeSelection,
} from '../../components/ReviewTypeFilter/reviewTypeSelection'
import type { TypeSelection } from '../../components/ReviewTypeFilter/reviewTypeSelection'
import { ANY_RATING_FILTER } from './types'
import type { RatingDirection, RatingFilter } from './types'

/** `?rating=1…5` (+ `rating_dir=below`); anything else is "any rating". */
function parseRatingParams(searchParams: URLSearchParams): RatingFilter {
  const value = Number(searchParams.get('rating'))
  if (!Number.isInteger(value) || value < 1 || value > 5) return ANY_RATING_FILTER
  const direction: RatingDirection = searchParams.get('rating_dir') === 'below' ? 'below' : 'up'
  return { value, direction }
}

/** A query parameter's value, or null when absent or empty. */
function nonEmptyParam(searchParams: URLSearchParams, name: string): string | null {
  const value = searchParams.get(name)
  return value === null || value === '' ? null : value
}

/** Read-only snapshot of the current filter values. */
export interface CategoryFiltersState {
  searchText: string
  /** The facet lists (any of each; empty = all), as `api/feedbackFacets.ts` reads them. */
  facets: FeedbackFacets
  selectedCategories: readonly string[]
  selectedSources: readonly string[]
  selectedSentiments: readonly SentimentFacet[]
  selectedUsefulness: readonly UsefulnessFacet[]
  /** One subcategory id (a server filter on every list route), or null. */
  subcategory: string | null
  ratingFilter: RatingFilter
  showUrgentOnly: boolean
  /** Exact `source_channel`, or null for every channel. */
  channel: string | null
  /** `{dimension key: value}` for the configured dimensions (never `feedback_type`); every pair must match. */
  dimensionFilter: Record<string, string>
  /** The pressed review-type pills; empty = every type. */
  types: TypeSelection
  /** One tag (matched ignoring case), or null. */
  tag: string | null
}

/** Every key of {@link AttributeFilters}, in the order they go on the URL. */
const ATTRIBUTE_FILTER_KEYS: readonly (keyof AttributeFilters)[] = ['channel', 'dims', 'tag']

/** The `dims` value: the configured dimensions' pairs, then the review types (`key:a|b` cannot go through serializeDims). */
function dimsOf(state: Pick<CategoryFiltersState, 'dimensionFilter' | 'types'>): string | undefined {
  const parts = [serializeDims(state.dimensionFilter), typeSelectionDims(state.types)]
    .filter((part): part is string => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(',')
}

/** The `channel` / `dims` / `tag` query parameters of a filter state (absent when unset). */
export function attributeFiltersOf(state: Pick<CategoryFiltersState, 'channel' | 'dimensionFilter' | 'types' | 'tag'>): AttributeFilters {
  const dims = dimsOf(state)
  return {
    ...(state.channel === null ? {} : { channel: state.channel }),
    ...(dims === undefined ? {} : { dims }),
    ...(state.tag === null ? {} : { tag: state.tag }),
  }
}

/** The server's `rating_min` / `rating_max` for the picker's threshold and direction. */
export function ratingParamsOf(filter: RatingFilter): Pick<ItemFilterParams, 'rating_min' | 'rating_max'> {
  if (filter.value === 0) return {}
  return filter.direction === 'up' ? { rating_min: filter.value } : { rating_max: filter.value }
}

/**
 * Every server-side item filter of the state: the attributes, the stars and "urgent only".
 * The breakdown cards (distribution, gauge, keywords) read with these, so they count what
 * the list shows (5.34.00: rating and urgent changed only the list).
 */
export function breakdownFiltersOf(
  state: Pick<CategoryFiltersState, 'channel' | 'dimensionFilter' | 'types' | 'tag' | 'ratingFilter' | 'showUrgentOnly' | 'selectedUsefulness'>,
): ItemFilterParams {
  return {
    ...attributeFiltersOf(state),
    ...ratingParamsOf(state.ratingFilter),
    ...(state.showUrgentOnly ? { urgent: 1 } : {}),
    ...(state.selectedUsefulness.length > 0 ? { usefulness: state.selectedUsefulness.join(',') } : {}),
  }
}

/** Filter values plus the mutation handlers the page wires into its UI. */
export interface CategoryFiltersApi extends CategoryFiltersState {
  setSearchText: (value: string) => void
  toggleCategory: (category: string) => void
  setSubcategory: (value: string | null) => void
  /** Check or uncheck one value of a facet list. */
  toggleFacet: (name: FacetName, value: string) => void
  clearFacet: (name: FacetName) => void
  setRatingFilter: (value: RatingFilter) => void
  setShowUrgentOnly: (value: boolean) => void
  setChannel: (value: string | null) => void
  setDimensionFilter: (value: Record<string, string>) => void
  setTypes: (value: TypeSelection) => void
  setTag: (value: string | null) => void
  clearFilters: () => void
  hasActiveFilters: boolean
}

function computeHasActiveFilters(state: CategoryFiltersState): boolean {
  return (
    state.searchText !== '' ||
    facetEntries(state.facets).length > 0 ||
    state.subcategory !== null ||
    state.ratingFilter.value > 0 ||
    state.showUrgentOnly ||
    Object.keys(attributeFiltersOf(state)).length > 0
  )
}

/** The URL-synced subset of the filter state. */
type ShareableFilters = Pick<CategoryFiltersState,
  'searchText' | 'facets' | 'subcategory' | 'ratingFilter' | 'showUrgentOnly' | 'channel' | 'dimensionFilter' | 'types' | 'tag'>

/**
 * Every query key this hook writes (plus the dropped legacy `all`). Anything
 * else in the URL — the review modal's `review` / `reviewBrand` — is kept.
 */
const OWNED_PARAMS: readonly string[] = [
  'q', ...Object.values(FACET_PARAMS), 'subcategory', 'rating', 'rating_dir', 'urgent', 'channel', 'dims', 'tag', 'types', 'all',
]

/**
 * The configured-dimension pairs and the review types a URL says. `types` wins; without it, an old
 * link's `dims=feedback_type:<value>` becomes that one pill. `feedback_type` never stays a dimension pair.
 */
function readDimsAndTypes(searchParams: URLSearchParams): Pick<ShareableFilters, 'dimensionFilter' | 'types'> {
  const { [FEEDBACK_TYPE_KEY]: legacyType, ...dimensionFilter } = parseDims(searchParams.get('dims'))
  // An unknown legacy value reads as every type, like an unreadable `types`.
  return { dimensionFilter, types: readTypeSelection(searchParams.get('types') ?? legacyType ?? null, ALL_TYPES) }
}

/** Canonical query string for the URL-synced subset of the filter state. */
function buildShareableParams(filters: ShareableFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.searchText) params.set('q', filters.searchText)
  for (const [key, value] of facetEntries(filters.facets)) params.set(key, value)
  if (filters.subcategory !== null) params.set('subcategory', filters.subcategory)
  if (filters.ratingFilter.value > 0) params.set('rating', String(filters.ratingFilter.value))
  if (filters.ratingFilter.value > 0 && filters.ratingFilter.direction === 'below') params.set('rating_dir', 'below')
  if (filters.showUrgentOnly) params.set('urgent', '1')
  // The URL keeps the types as `types` (readable, shareable); only the server request folds them into `dims`.
  const attributes = attributeFiltersOf({ ...filters, types: ALL_TYPES })
  for (const key of ATTRIBUTE_FILTER_KEYS) {
    const value = attributes[key]
    if (value !== undefined) params.set(key, value)
  }
  const types = writeTypeSelection(filters.types, ALL_TYPES)
  if (types !== null) params.set('types', types)
  return params
}

/** The shareable filters a URL says. */
function readShareableParams(searchParams: URLSearchParams): ShareableFilters {
  return {
    searchText: searchParams.get('q') ?? '',
    facets: readFacets(searchParams),
    subcategory: nonEmptyParam(searchParams, 'subcategory'),
    ratingFilter: parseRatingParams(searchParams),
    showUrgentOnly: searchParams.get('urgent') === '1',
    channel: nonEmptyParam(searchParams, 'channel'),
    ...readDimsAndTypes(searchParams),
    tag: nonEmptyParam(searchParams, 'tag'),
  }
}

export function useCategoryFilters(): CategoryFiltersApi {
  const [searchParams, setSearchParams] = useSearchParams()

  const [searchText, setSearchText] = useState(searchParams.get('q') ?? '')
  const [facets, setFacets] = useState<FeedbackFacets>(() => readFacets(searchParams))
  const [subcategory, setSubcategory] = useState<string | null>(() => nonEmptyParam(searchParams, 'subcategory'))
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>(() => parseRatingParams(searchParams))
  const [showUrgentOnly, setShowUrgentOnly] = useState(() => searchParams.get('urgent') === '1')
  const [channel, setChannel] = useState<string | null>(() => nonEmptyParam(searchParams, 'channel'))
  const [initialDims] = useState(() => readDimsAndTypes(searchParams))
  const [dimensionFilter, setDimensionFilter] = useState<Record<string, string>>(initialDims.dimensionFilter)
  const [types, setTypes] = useState<TypeSelection>(initialDims.types)
  const [tag, setTag] = useState<string | null>(() => nonEmptyParam(searchParams, 'tag'))
  const shareable: ShareableFilters = {
    searchText, facets, subcategory, ratingFilter, showUrgentOnly, channel, dimensionFilter, types, tag,
  }

  // Canonical form of what the URL says vs. what the state says. When they
  // disagree right after the URL changed, the change came from outside
  // (browser back/forward, same-route navigation to /categories?...) and the
  // state adopts it. Guarded render-phase updates per React's "adjusting
  // state when props change" pattern — our own URL mirroring converges the
  // two snapshots, so it never re-triggers adoption.
  const urlSnapshot = buildShareableParams(readShareableParams(searchParams)).toString()
  const stateSnapshot = buildShareableParams(shareable).toString()
  const [prevUrlSnapshot, setPrevUrlSnapshot] = useState(urlSnapshot)
  if (urlSnapshot !== prevUrlSnapshot) {
    setPrevUrlSnapshot(urlSnapshot)
    if (urlSnapshot !== stateSnapshot) {
      const fromUrl = readShareableParams(searchParams)
      setSearchText(fromUrl.searchText)
      setFacets(fromUrl.facets)
      setSubcategory(fromUrl.subcategory)
      setRatingFilter(fromUrl.ratingFilter)
      setShowUrgentOnly(fromUrl.showUrgentOnly)
      setChannel(fromUrl.channel)
      setDimensionFilter(fromUrl.dimensionFilter)
      setTypes(fromUrl.types)
      setTag(fromUrl.tag)
    }
  }

  // Mirror the shareable filters to the URL (replace, not push, so the
  // browser back button isn't flooded by keystrokes). Only OUR keys are
  // rewritten, so an open review modal (`?review=`) survives. The legacy `all=1`
  // param is intentionally dropped: browse-all is now the default state.
  // Keyed on the canonical string, so a re-created dimension object with the same pairs is no change.
  useEffect(() => {
    setSearchParams((current) => withOwnedParams(current, OWNED_PARAMS, new URLSearchParams(stateSnapshot)), { replace: true })
  }, [stateSnapshot, setSearchParams])

  // Validated on the way back in: the URL mirror reads every value through `readFacets`.
  const toggleFacet = (name: FacetName, value: string) => {
    setFacets((prev) => readFacets(new URLSearchParams(facetEntries({
      ...prev, [name]: toggleFacetValue<string>(prev[name], value),
    }))))
  }
  const clearFacet = (name: FacetName) => setFacets((prev) => ({ ...prev, [name]: [] }))

  const clearFilters = () => {
    setSearchText('')
    setFacets(EMPTY_FACETS)
    setSubcategory(null)
    setRatingFilter(ANY_RATING_FILTER)
    setShowUrgentOnly(false)
    setChannel(null)
    setDimensionFilter({})
    setTypes(ALL_TYPES)
    setTag(null)
  }

  const state: CategoryFiltersState = {
    ...shareable,
    selectedCategories: facets.categories,
    selectedSources: facets.sources,
    selectedSentiments: facets.sentiments,
    selectedUsefulness: facets.usefulness,
  }

  return {
    ...state,
    setSearchText,
    toggleCategory: (category) => toggleFacet('categories', category),
    setSubcategory,
    toggleFacet,
    clearFacet,
    setRatingFilter,
    setShowUrgentOnly,
    setChannel,
    setDimensionFilter,
    setTypes,
    setTag,
    clearFilters,
    hasActiveFilters: computeHasActiveFilters(state),
  }
}
