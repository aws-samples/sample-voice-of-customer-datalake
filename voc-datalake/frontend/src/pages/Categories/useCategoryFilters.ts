/**
 * @fileoverview Filter state for the Categories page.
 *
 * The shared dimensions (sources, categories, sentiment, urgency, enrichment
 * fields, custom fields) live in the per-page filter store, so they survive
 * navigation and reloads. They are ALSO mirrored to the URL with the same keys
 * the API takes (`?source=a,b&category=x&usefulness=high&cf_region=EMEA`), so a
 * filtered view is a shareable link and FeedbackDetail tag clicks can deep-link
 * into it. Free-text search rides along as `q`; the star-rating filter is
 * page-local and not shared.
 *
 * Precedence: a URL that carries filters wins (a deep link means "show me
 * this"); a bare `/categories` restores the remembered filters and writes them
 * back to the URL.
 *
 * @module pages/Categories/useCategoryFilters
 */
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  feedbackFiltersFromSearchParams,
  filteredSearchParams,
  filtersKey,
  hasActiveFilters,
  isFilterParam,
  toggleValue,
} from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import { useFeedbackFilterStore, usePageFilters } from '../../store/feedbackFilterStore'
import { ANY_RATING_FILTER } from './types'
import type { RatingFilter } from './types'

const PAGE = 'categories'
const SEARCH_PARAM = 'q'

/** Read-only snapshot of the current filter values. */
export interface CategoryFiltersState {
  searchText: string
  ratingFilter: RatingFilter
  /** The shared, persisted, URL-mirrored dimensions. */
  filters: FeedbackFilterState
}

/** Filter values plus the mutation handlers the page wires into its UI. */
export interface CategoryFiltersApi extends CategoryFiltersState {
  setSearchText: (value: string) => void
  setRatingFilter: (value: RatingFilter) => void
  setFilters: (next: FeedbackFilterState) => void
  toggleCategory: (category: string) => void
  toggleSentiment: (sentiment: string) => void
  clearFilters: () => void
  /** Anything narrowing the page, including the page-local search and rating. */
  hasActiveFilters: boolean
}

function urlHasShareableState(params: URLSearchParams): boolean {
  return [...params.keys()].some((key) => key === SEARCH_PARAM || isFilterParam(key))
}

/** Canonical query string for the URL-synced state (stable across selection order). */
function shareableSnapshot(searchText: string, filters: FeedbackFilterState): string {
  return JSON.stringify([searchText, filtersKey(filters)])
}

/** Same encoding as the API requests, so a repeated `cf_<key>` survives the URL too. */
function buildShareableParams(searchText: string, filters: FeedbackFilterState): URLSearchParams {
  return filteredSearchParams({ [SEARCH_PARAM]: searchText || null }, filters)
}

export function useCategoryFilters(): CategoryFiltersApi {
  const [searchParams, setSearchParams] = useSearchParams()

  // Deep-link adoption, synchronously on first render: written to the store
  // BEFORE the store is read below, so the first render already shows the
  // linked filters and the URL mirror never overwrites the link with the
  // remembered selection. Idempotent, so a StrictMode double call is harmless.
  useState(() => {
    if (urlHasShareableState(searchParams)) {
      useFeedbackFilterStore.getState().setPageFilters(PAGE, feedbackFiltersFromSearchParams(searchParams))
    }
    return true
  })
  const { filters, setFilters, clearFilters: clearStoredFilters } = usePageFilters(PAGE)
  const [searchText, setSearchText] = useState(searchParams.get(SEARCH_PARAM) ?? '')
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>(ANY_RATING_FILTER)

  // External URL changes (browser back/forward, same-route navigation to
  // /categories?...) are adopted when they disagree with the state. Our own
  // mirroring below converges the two snapshots, so it never re-triggers this.
  const urlSearch = searchParams.get(SEARCH_PARAM) ?? ''
  const urlFilters = feedbackFiltersFromSearchParams(searchParams)
  const urlSnapshot = shareableSnapshot(urlSearch, urlFilters)
  const [prevUrlSnapshot, setPrevUrlSnapshot] = useState(urlSnapshot)
  if (urlSnapshot !== prevUrlSnapshot) {
    setPrevUrlSnapshot(urlSnapshot)
    if (urlSnapshot !== shareableSnapshot(searchText, filters)) {
      setSearchText(urlSearch)
      setFilters(urlFilters)
    }
  }

  // Mirror to the URL (replace, so keystrokes don't flood history).
  useEffect(() => {
    setSearchParams(buildShareableParams(searchText, filters), { replace: true })
  }, [searchText, filters, setSearchParams])

  const clearFilters = () => {
    setSearchText('')
    setRatingFilter(ANY_RATING_FILTER)
    clearStoredFilters()
  }

  return {
    searchText,
    ratingFilter,
    filters,
    setSearchText,
    setRatingFilter,
    setFilters,
    toggleCategory: (category) => setFilters({ ...filters, categories: toggleValue(filters.categories, category) }),
    toggleSentiment: (sentiment) => setFilters({ ...filters, sentiments: toggleValue(filters.sentiments, sentiment) }),
    clearFilters,
    hasActiveFilters: searchText !== '' || ratingFilter.value > 0 || hasActiveFilters(filters),
  }
}
