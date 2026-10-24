/**
 * @fileoverview URL-synced filter state for the Categories page.
 *
 * Owns every user-adjustable feedback filter and mirrors the shareable
 * subset (q / source / sentiment / category / subcategory / rating / urgent / channel / dims / tag)
 * to the URL so links are
 * shareable and FeedbackDetail tag-clicks can deep-link into a pre-filtered
 * Categories view. Multi-select categories are encoded comma-separated
 * (`?category=a,b`); single-value deep-links simply select one chip.
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
import type { AttributeFilters } from '../../api/types'
import { withOwnedParams } from '../../utils/searchParams'
import { ANY_RATING_FILTER } from './types'
import type { RatingDirection, RatingFilter, SentimentFilter } from './types'

const SENTIMENT_VALUES: readonly SentimentFilter[] = ['all', 'positive', 'negative', 'neutral', 'mixed']

function isSentimentFilter(value: string): value is SentimentFilter {
  return SENTIMENT_VALUES.some((v) => v === value)
}

function parseSentimentParam(value: string | null): SentimentFilter {
  if (value !== null && isSentimentFilter(value)) return value
  return 'all'
}

function parseCategoriesParam(value: string | null): string[] {
  if (value === null || value === '') return []
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

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
  selectedCategories: string[]
  /** One subcategory id (refined client-side: the list routes take no subcategory), or null. */
  subcategory: string | null
  selectedSource: string | null
  sentimentFilter: SentimentFilter
  ratingFilter: RatingFilter
  showUrgentOnly: boolean
  /** Exact `source_channel`, or null for every channel. */
  channel: string | null
  /** `{dimension key: value}`; every pair must match. */
  dimensionFilter: Record<string, string>
  /** One tag (matched ignoring case), or null. */
  tag: string | null
}

/** The `channel` / `dims` / `tag` query parameters of a filter state (absent when unset). */
export function attributeFiltersOf(state: Pick<CategoryFiltersState, 'channel' | 'dimensionFilter' | 'tag'>): AttributeFilters {
  const dims = serializeDims(state.dimensionFilter)
  return {
    ...(state.channel === null ? {} : { channel: state.channel }),
    ...(dims === undefined ? {} : { dims }),
    ...(state.tag === null ? {} : { tag: state.tag }),
  }
}

/** Filter values plus the mutation handlers the page wires into its UI. */
export interface CategoryFiltersApi extends CategoryFiltersState {
  setSearchText: (value: string) => void
  toggleCategory: (category: string) => void
  setSubcategory: (value: string | null) => void
  setSelectedSource: (value: string | null) => void
  setSentimentFilter: (value: SentimentFilter) => void
  setRatingFilter: (value: RatingFilter) => void
  setShowUrgentOnly: (value: boolean) => void
  setChannel: (value: string | null) => void
  setDimensionFilter: (value: Record<string, string>) => void
  setTag: (value: string | null) => void
  clearFilters: () => void
  hasActiveFilters: boolean
}

function computeHasActiveFilters(state: CategoryFiltersState): boolean {
  return (
    state.searchText !== '' ||
    state.selectedCategories.length > 0 ||
    state.subcategory !== null ||
    state.selectedSource !== null ||
    state.sentimentFilter !== 'all' ||
    state.ratingFilter.value > 0 ||
    state.showUrgentOnly ||
    Object.keys(attributeFiltersOf(state)).length > 0
  )
}

/** The URL-synced subset of the filter state. */
type ShareableFilters = Pick<CategoryFiltersState,
  'searchText' | 'selectedSource' | 'sentimentFilter' | 'selectedCategories' | 'subcategory' | 'ratingFilter'
  | 'showUrgentOnly' | 'channel' | 'dimensionFilter' | 'tag'>

/**
 * Every query key this hook writes (plus the dropped legacy `all`). Anything
 * else in the URL — the review modal's `review` / `reviewBrand` — is kept.
 */
const OWNED_PARAMS: readonly string[] = [
  'q', 'source', 'sentiment', 'category', 'subcategory', 'rating', 'rating_dir', 'urgent', 'channel', 'dims', 'tag', 'all',
]

/** Canonical query string for the URL-synced subset of the filter state. */
function buildShareableParams(filters: ShareableFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.searchText) params.set('q', filters.searchText)
  if (filters.selectedSource) params.set('source', filters.selectedSource)
  if (filters.sentimentFilter !== 'all') params.set('sentiment', filters.sentimentFilter)
  if (filters.selectedCategories.length > 0) params.set('category', filters.selectedCategories.join(','))
  if (filters.subcategory !== null) params.set('subcategory', filters.subcategory)
  if (filters.ratingFilter.value > 0) params.set('rating', String(filters.ratingFilter.value))
  if (filters.ratingFilter.value > 0 && filters.ratingFilter.direction === 'below') params.set('rating_dir', 'below')
  if (filters.showUrgentOnly) params.set('urgent', '1')
  for (const [key, value] of Object.entries(attributeFiltersOf(filters))) params.set(key, value)
  return params
}

/** The shareable filters a URL says. */
function readShareableParams(searchParams: URLSearchParams): ShareableFilters {
  return {
    searchText: searchParams.get('q') ?? '',
    selectedSource: searchParams.get('source'),
    sentimentFilter: parseSentimentParam(searchParams.get('sentiment')),
    selectedCategories: parseCategoriesParam(searchParams.get('category')),
    subcategory: nonEmptyParam(searchParams, 'subcategory'),
    ratingFilter: parseRatingParams(searchParams),
    showUrgentOnly: searchParams.get('urgent') === '1',
    channel: nonEmptyParam(searchParams, 'channel'),
    dimensionFilter: parseDims(searchParams.get('dims')),
    tag: nonEmptyParam(searchParams, 'tag'),
  }
}

export function useCategoryFilters(): CategoryFiltersApi {
  const [searchParams, setSearchParams] = useSearchParams()

  const [searchText, setSearchText] = useState(searchParams.get('q') ?? '')
  const [selectedCategories, setSelectedCategories] = useState<string[]>(() =>
    parseCategoriesParam(searchParams.get('category'))
  )
  const [selectedSource, setSelectedSource] = useState<string | null>(searchParams.get('source'))
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>(() =>
    parseSentimentParam(searchParams.get('sentiment'))
  )
  const [subcategory, setSubcategory] = useState<string | null>(() => nonEmptyParam(searchParams, 'subcategory'))
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>(() => parseRatingParams(searchParams))
  const [showUrgentOnly, setShowUrgentOnly] = useState(() => searchParams.get('urgent') === '1')
  const [channel, setChannel] = useState<string | null>(() => nonEmptyParam(searchParams, 'channel'))
  const [dimensionFilter, setDimensionFilter] = useState<Record<string, string>>(() => parseDims(searchParams.get('dims')))
  const [tag, setTag] = useState<string | null>(() => nonEmptyParam(searchParams, 'tag'))
  const shareable: ShareableFilters = {
    searchText, selectedSource, sentimentFilter, selectedCategories, subcategory, ratingFilter, showUrgentOnly,
    channel, dimensionFilter, tag,
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
      setSelectedSource(fromUrl.selectedSource)
      setSentimentFilter(fromUrl.sentimentFilter)
      setSelectedCategories(fromUrl.selectedCategories)
      setSubcategory(fromUrl.subcategory)
      setRatingFilter(fromUrl.ratingFilter)
      setShowUrgentOnly(fromUrl.showUrgentOnly)
      setChannel(fromUrl.channel)
      setDimensionFilter(fromUrl.dimensionFilter)
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

  const toggleCategory = (category: string) => {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    )
  }

  const clearFilters = () => {
    setSearchText('')
    setSelectedCategories([])
    setSubcategory(null)
    setSelectedSource(null)
    setSentimentFilter('all')
    setRatingFilter(ANY_RATING_FILTER)
    setShowUrgentOnly(false)
    setChannel(null)
    setDimensionFilter({})
    setTag(null)
  }

  const state: CategoryFiltersState = shareable

  return {
    ...state,
    setSearchText,
    toggleCategory,
    setSubcategory,
    setSelectedSource,
    setSentimentFilter,
    setRatingFilter,
    setShowUrgentOnly,
    setChannel,
    setDimensionFilter,
    setTag,
    clearFilters,
    hasActiveFilters: computeHasActiveFilters(state),
  }
}
