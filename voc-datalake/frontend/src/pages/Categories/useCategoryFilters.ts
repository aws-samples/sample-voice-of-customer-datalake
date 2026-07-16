/**
 * @fileoverview URL-synced filter state for the Categories page.
 *
 * Owns every user-adjustable feedback filter and mirrors the shareable
 * subset (q / source / sentiment / category / all) to the URL so links are
 * shareable and FeedbackDetail tag-clicks can deep-link into a pre-filtered
 * Categories view. Multi-select categories are encoded comma-separated
 * (`?category=a,b`); single-value deep-links simply select one chip.
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
  selectedKeywords: string[]
  selectedSource: string | null
  sentimentFilter: SentimentFilter
  minRating: number
  showAll: boolean
  showUrgentOnly: boolean
}

/** Filter values plus the mutation handlers the page wires into its UI. */
export interface CategoryFiltersApi extends CategoryFiltersState {
  setSearchText: (value: string) => void
  toggleCategory: (category: string) => void
  toggleKeyword: (keyword: string) => void
  clearKeywords: () => void
  setSelectedSource: (value: string | null) => void
  setSentimentFilter: (value: SentimentFilter) => void
  setMinRating: (value: number) => void
  toggleShowAll: () => void
  setShowUrgentOnly: (value: boolean) => void
  clearFilters: () => void
  hasActiveFilters: boolean
}

function computeHasActiveFilters(state: CategoryFiltersState): boolean {
  return (
    state.searchText !== '' ||
    state.selectedCategories.length > 0 ||
    state.selectedKeywords.length > 0 ||
    state.selectedSource !== null ||
    state.sentimentFilter !== 'all' ||
    state.minRating > 0 ||
    state.showAll ||
    state.showUrgentOnly
  )
}

export function useCategoryFilters(): CategoryFiltersApi {
  const [searchParams, setSearchParams] = useSearchParams()

  const [searchText, setSearchText] = useState(searchParams.get('q') ?? '')
  const [selectedCategories, setSelectedCategories] = useState<string[]>(() =>
    parseCategoriesParam(searchParams.get('category'))
  )
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([])
  const [selectedSource, setSelectedSource] = useState<string | null>(searchParams.get('source'))
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>(() =>
    parseSentimentParam(searchParams.get('sentiment'))
  )
  const [minRating, setMinRating] = useState(0)
  const [showAll, setShowAll] = useState(searchParams.get('all') === '1')
  const [showUrgentOnly, setShowUrgentOnly] = useState(false)

  // Mirror the shareable filters to the URL (replace, not push, so the
  // browser back button isn't flooded by keystrokes).
  useEffect(() => {
    const params = new URLSearchParams()
    if (searchText) params.set('q', searchText)
    if (selectedSource) params.set('source', selectedSource)
    if (sentimentFilter !== 'all') params.set('sentiment', sentimentFilter)
    if (selectedCategories.length > 0) params.set('category', selectedCategories.join(','))
    if (showAll) params.set('all', '1')
    setSearchParams(params, { replace: true })
  }, [searchText, selectedSource, sentimentFilter, selectedCategories, showAll, setSearchParams])

  const toggleCategory = (category: string) => {
    setShowAll(false)
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    )
  }

  const toggleKeyword = (keyword: string) => {
    setShowAll(false)
    setSelectedKeywords((prev) =>
      prev.includes(keyword) ? prev.filter((k) => k !== keyword) : [...prev, keyword]
    )
  }

  const clearKeywords = () => setSelectedKeywords([])

  // "All" browses everything: selecting it clears the narrowing chip
  // selections; selecting a chip switches All back off (see toggle* above).
  const toggleShowAll = () => {
    const next = !showAll
    setShowAll(next)
    if (next) {
      setSelectedCategories([])
      setSelectedKeywords([])
    }
  }

  const clearFilters = () => {
    setSearchText('')
    setSelectedCategories([])
    setSelectedKeywords([])
    setSelectedSource(null)
    setSentimentFilter('all')
    setMinRating(0)
    setShowAll(false)
    setShowUrgentOnly(false)
  }

  const state: CategoryFiltersState = {
    searchText,
    selectedCategories,
    selectedKeywords,
    selectedSource,
    sentimentFilter,
    minRating,
    showAll,
    showUrgentOnly,
  }

  return {
    ...state,
    setSearchText,
    toggleCategory,
    toggleKeyword,
    clearKeywords,
    setSelectedSource,
    setSentimentFilter,
    setMinRating,
    toggleShowAll,
    setShowUrgentOnly,
    clearFilters,
    hasActiveFilters: computeHasActiveFilters(state),
  }
}
