/**
 * @fileoverview URL-synced filter state for the Categories page.
 *
 * Owns every user-adjustable feedback filter and mirrors the shareable
 * subset (q / source / sentiment / category) to the URL so links are
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
import type { SentimentFilter } from './types'

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

/** Read-only snapshot of the current filter values. */
export interface CategoryFiltersState {
  searchText: string
  selectedCategories: string[]
  selectedSource: string | null
  sentimentFilter: SentimentFilter
  minRating: number
  showUrgentOnly: boolean
}

/** Filter values plus the mutation handlers the page wires into its UI. */
export interface CategoryFiltersApi extends CategoryFiltersState {
  setSearchText: (value: string) => void
  toggleCategory: (category: string) => void
  setSelectedSource: (value: string | null) => void
  setSentimentFilter: (value: SentimentFilter) => void
  setMinRating: (value: number) => void
  setShowUrgentOnly: (value: boolean) => void
  clearFilters: () => void
  hasActiveFilters: boolean
}

function computeHasActiveFilters(state: CategoryFiltersState): boolean {
  return (
    state.searchText !== '' ||
    state.selectedCategories.length > 0 ||
    state.selectedSource !== null ||
    state.sentimentFilter !== 'all' ||
    state.minRating > 0 ||
    state.showUrgentOnly
  )
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
  const [minRating, setMinRating] = useState(0)
  const [showUrgentOnly, setShowUrgentOnly] = useState(false)

  // Mirror the shareable filters to the URL (replace, not push, so the
  // browser back button isn't flooded by keystrokes). The legacy `all=1`
  // param is intentionally dropped: browse-all is now the default state.
  useEffect(() => {
    const params = new URLSearchParams()
    if (searchText) params.set('q', searchText)
    if (selectedSource) params.set('source', selectedSource)
    if (sentimentFilter !== 'all') params.set('sentiment', sentimentFilter)
    if (selectedCategories.length > 0) params.set('category', selectedCategories.join(','))
    setSearchParams(params, { replace: true })
  }, [searchText, selectedSource, sentimentFilter, selectedCategories, setSearchParams])

  const toggleCategory = (category: string) => {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    )
  }

  const clearFilters = () => {
    setSearchText('')
    setSelectedCategories([])
    setSelectedSource(null)
    setSentimentFilter('all')
    setMinRating(0)
    setShowUrgentOnly(false)
  }

  const state: CategoryFiltersState = {
    searchText,
    selectedCategories,
    selectedSource,
    sentimentFilter,
    minRating,
    showUrgentOnly,
  }

  return {
    ...state,
    setSearchText,
    toggleCategory,
    setSelectedSource,
    setSentimentFilter,
    setMinRating,
    setShowUrgentOnly,
    clearFilters,
    hasActiveFilters: computeHasActiveFilters(state),
  }
}
