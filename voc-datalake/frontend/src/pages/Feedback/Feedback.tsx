/**
 * @fileoverview Feedback list page with filtering and search.
 *
 * Features:
 * - Full-text search across feedback items
 * - Filter by source, sentiment, category, urgency
 * - URL-synced filter state for shareable links
 * - Dynamic filter options from entities API
 *
 * @module pages/Feedback
 */

import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Search, Filter, SortDesc, X } from 'lucide-react'
import { api, getDaysFromRange } from '../../api/client'
import type { FeedbackItem } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import FeedbackCard from '../../components/FeedbackCard'

const sentiments = ['all', 'positive', 'neutral', 'negative', 'mixed']
const defaultCategories = ['all', 'delivery', 'customer_support', 'product_quality', 'pricing', 'website', 'app', 'billing', 'returns', 'communication', 'other']

// Loading spinner component
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  )
}

// Empty state component
function EmptyState() {
  return (
    <div className="text-center py-12">
      <p className="text-gray-500">No feedback found matching your filters</p>
    </div>
  )
}

// Feedback grid component
function FeedbackGrid({ items }: Readonly<{ items: readonly FeedbackItem[] }>) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
      {items.map((item) => (
        <FeedbackCard key={item.feedback_id} feedback={item} />
      ))}
    </div>
  )
}

// Feedback list content - handles loading/empty/list states
function FeedbackListContent({ isLoading, items }: Readonly<{ isLoading: boolean; items: readonly FeedbackItem[] }>) {
  if (isLoading) return <LoadingSpinner />
  if (items.length === 0) return <EmptyState />
  return <FeedbackGrid items={items} />
}

// Helper to build sources list from entities
function buildSourcesList(entitiesData: { entities?: { sources?: Record<string, number> } } | undefined): string[] {
  if (!entitiesData?.entities?.sources) return ['all']
  const sourceNames = Object.keys(entitiesData.entities.sources)
    .sort((a, b) => (entitiesData.entities?.sources?.[b] ?? 0) - (entitiesData.entities?.sources?.[a] ?? 0))
  return ['all', ...sourceNames]
}

// Helper to build categories list from entities
function buildCategoriesList(entitiesData: { entities?: { categories?: Record<string, number> } } | undefined): string[] {
  if (!entitiesData?.entities?.categories) return defaultCategories
  const categoryNames = Object.keys(entitiesData.entities.categories)
    .sort((a, b) => (entitiesData.entities?.categories?.[b] ?? 0) - (entitiesData.entities?.categories?.[a] ?? 0))
  return ['all', ...categoryNames]
}

// Helper to check if any filters are active
function checkHasActiveFilters(
  search: string,
  sourceFilter: string,
  sentimentFilter: string,
  categoryFilter: string,
  showUrgentOnly: boolean
): boolean {
  return Boolean(search) || sourceFilter !== 'all' || sentimentFilter !== 'all' || categoryFilter !== 'all' || showUrgentOnly
}

// Filter state interface
interface FilterState {
  search: string
  sourceFilter: string
  sentimentFilter: string
  categoryFilter: string
  showUrgentOnly: boolean
}

// Filters card component
function FiltersCard({
  filters,
  sources,
  categories,
  onSearchChange,
  onSourceChange,
  onSentimentChange,
  onCategoryChange,
  onUrgentChange,
}: Readonly<{
  filters: FilterState
  sources: string[]
  categories: string[]
  onSearchChange: (value: string) => void
  onSourceChange: (value: string) => void
  onSentimentChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onUrgentChange: (value: boolean) => void
}>) {
  return (
    <div className="card !p-4 sm:!p-6">
      <div className="flex flex-col gap-3 sm:gap-4">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={18} />
          <input
            type="text"
            placeholder="Search feedback..."
            value={filters.search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="input !pl-11"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <Filter size={16} className="text-gray-400 flex-shrink-0 hidden sm:block" />
            <select value={filters.sourceFilter} onChange={(e) => onSourceChange(e.target.value)} className="input w-full sm:w-auto text-sm">
              {sources.map(s => <option key={s} value={s}>{s === 'all' ? 'All Sources' : s}</option>)}
            </select>
          </div>
          <select value={filters.sentimentFilter} onChange={(e) => onSentimentChange(e.target.value)} className="input w-full sm:w-auto text-sm flex-1 sm:flex-none">
            {sentiments.map(s => <option key={s} value={s}>{s === 'all' ? 'All Sentiments' : s}</option>)}
          </select>
          <select value={filters.categoryFilter} onChange={(e) => onCategoryChange(e.target.value)} className="input w-full sm:w-auto text-sm flex-1 sm:flex-none">
            {categories.map(c => <option key={c} value={c}>{c === 'all' ? 'All Categories' : c.replace('_', ' ')}</option>)}
          </select>
          <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap">
            <input type="checkbox" checked={filters.showUrgentOnly} onChange={(e) => onUrgentChange(e.target.checked)} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
            <span className="text-sm text-gray-700">Urgent only</span>
          </label>
        </div>
      </div>
    </div>
  )
}

// Results header component
function ResultsHeader({
  itemCount,
  totalCount,
  search,
  hasActiveFilters,
  onClearFilters,
}: Readonly<{
  itemCount: number
  totalCount: number
  search: string
  hasActiveFilters: boolean
  onClearFilters: () => void
}>) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
      <p className="text-sm text-gray-500">
        Showing {itemCount} of {totalCount} items
        {search && <span className="ml-1">for "{search}"</span>}
      </p>
      <div className="flex items-center gap-3">
        {hasActiveFilters && (
          <button onClick={onClearFilters} className="flex items-center gap-1 text-sm text-red-600 hover:text-red-700">
            <X size={14} />
            Clear filters
          </button>
        )}
        <button className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <SortDesc size={14} />
          Most recent
        </button>
      </div>
    </div>
  )
}

// Helper to build URL params from filters
function buildUrlParams(search: string, sourceFilter: string, sentimentFilter: string, categoryFilter: string): URLSearchParams {
  const params = new URLSearchParams()
  if (search) params.set('q', search)
  if (sourceFilter !== 'all') params.set('source', sourceFilter)
  if (sentimentFilter !== 'all') params.set('sentiment', sentimentFilter)
  if (categoryFilter !== 'all') params.set('category', categoryFilter)
  return params
}

// Helper to build feedback query params
function buildFeedbackQueryParams(
  days: number,
  sourceFilter: string,
  sentimentFilter: string,
  categoryFilter: string
): { days: number; source?: string; sentiment?: string; category?: string; limit: number } {
  return {
    days,
    source: sourceFilter !== 'all' ? sourceFilter : undefined,
    sentiment: sentimentFilter !== 'all' ? sentimentFilter : undefined,
    category: categoryFilter !== 'all' ? categoryFilter : undefined,
    limit: 100,
  }
}

// Helper to get feedback query function
function getFeedbackQueryFn(
  showUrgentOnly: boolean,
  days: number,
  feedbackQueryParams: ReturnType<typeof buildFeedbackQueryParams>
) {
  if (showUrgentOnly) {
    return () => api.getUrgentFeedback({ days, limit: 100 })
  }
  return () => api.getFeedback(feedbackQueryParams)
}

interface FeedbackDataResult {
  data: { items?: FeedbackItem[]; count?: number } | undefined
  isLoading: boolean
  isSearching: boolean
}

// Custom hook for feedback data fetching
function useFeedbackData(
  hasApiEndpoint: boolean,
  days: number,
  search: string,
  sourceFilter: string,
  sentimentFilter: string,
  categoryFilter: string,
  showUrgentOnly: boolean
): FeedbackDataResult {
  const isSearching = search.length >= 2
  const feedbackQueryParams = buildFeedbackQueryParams(days, sourceFilter, sentimentFilter, categoryFilter)
  const feedbackQueryFn = getFeedbackQueryFn(showUrgentOnly, days, feedbackQueryParams)

  // Server-side search when search term is provided
  const searchQuery = useQuery({
    queryKey: ['feedback-search', search, days],
    queryFn: () => api.searchFeedback({ q: search, days, limit: 100 }),
    enabled: hasApiEndpoint && isSearching,
  })

  // Regular feedback query
  const feedbackQuery = useQuery({
    queryKey: ['feedback', days, sourceFilter, sentimentFilter, categoryFilter, showUrgentOnly],
    queryFn: feedbackQueryFn,
    enabled: hasApiEndpoint && !isSearching,
  })

  if (isSearching) {
    return { data: searchQuery.data, isLoading: searchQuery.isLoading, isSearching }
  }
  return { data: feedbackQuery.data, isLoading: feedbackQuery.isLoading, isSearching }
}

export default function Feedback() {
  const { timeRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange)
  const [searchParams, setSearchParams] = useSearchParams()
  const hasApiEndpoint = !!config.apiEndpoint
  
  // Initialize from URL params
  const [search, setSearch] = useState(searchParams.get('q') ?? '')
  const [sourceFilter, setSourceFilter] = useState(searchParams.get('source') ?? 'all')
  const [sentimentFilter, setSentimentFilter] = useState(searchParams.get('sentiment') ?? 'all')
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') ?? 'all')
  const [showUrgentOnly, setShowUrgentOnly] = useState(false)

  // Fetch dynamic sources and categories from entities API
  const { data: entitiesData } = useQuery({
    queryKey: ['entities', days],
    queryFn: () => api.getEntities({ days, limit: 100 }),
    enabled: hasApiEndpoint,
  })

  // Build dynamic sources list from entities
  const sources = useMemo(() => buildSourcesList(entitiesData), [entitiesData])

  // Build dynamic categories list from entities
  const categories = useMemo(() => buildCategoriesList(entitiesData), [entitiesData])

  // Update URL when filters change
  useEffect(() => {
    const params = buildUrlParams(search, sourceFilter, sentimentFilter, categoryFilter)
    setSearchParams(params, { replace: true })
  }, [search, sourceFilter, sentimentFilter, categoryFilter, setSearchParams])

  // Fetch feedback data
  const { data: activeData, isLoading: activeLoading } = useFeedbackData(
    hasApiEndpoint,
    days,
    search,
    sourceFilter,
    sentimentFilter,
    categoryFilter,
    showUrgentOnly
  )

  const filteredItems = activeData?.items ?? []

  const clearFilters = () => {
    setSearch('')
    setSourceFilter('all')
    setSentimentFilter('all')
    setCategoryFilter('all')
    setShowUrgentOnly(false)
  }

  const hasActiveFilters = checkHasActiveFilters(search, sourceFilter, sentimentFilter, categoryFilter, showUrgentOnly)

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Please configure your API endpoint in Settings</p>
      </div>
    )
  }

  const filterState: FilterState = { search, sourceFilter, sentimentFilter, categoryFilter, showUrgentOnly }

  return (
    <div className="space-y-4 sm:space-y-6">
      <FiltersCard
        filters={filterState}
        sources={sources}
        categories={categories}
        onSearchChange={setSearch}
        onSourceChange={setSourceFilter}
        onSentimentChange={setSentimentFilter}
        onCategoryChange={setCategoryFilter}
        onUrgentChange={setShowUrgentOnly}
      />

      <ResultsHeader
        itemCount={filteredItems.length}
        totalCount={activeData?.count ?? 0}
        search={search}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={clearFilters}
      />

      <FeedbackListContent isLoading={activeLoading} items={filteredItems} />
    </div>
  )
}
