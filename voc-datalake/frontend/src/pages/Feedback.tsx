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
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import FeedbackCard from '../components/FeedbackCard'

const sentiments = ['all', 'positive', 'neutral', 'negative', 'mixed']
const defaultCategories = ['all', 'delivery', 'customer_support', 'product_quality', 'pricing', 'website', 'app', 'billing', 'returns', 'communication', 'other']

export default function Feedback() {
  const { timeRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange)
  const [searchParams, setSearchParams] = useSearchParams()
  
  // Initialize from URL params
  const [search, setSearch] = useState(searchParams.get('q') || '')
  const [sourceFilter, setSourceFilter] = useState(searchParams.get('source') || 'all')
  const [sentimentFilter, setSentimentFilter] = useState(searchParams.get('sentiment') || 'all')
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') || 'all')
  const [showUrgentOnly, setShowUrgentOnly] = useState(false)
  const [_isSearching, _setIsSearching] = useState(false) // Reserved for future use

  // Fetch dynamic sources and categories from entities API
  const { data: entitiesData } = useQuery({
    queryKey: ['entities', days],
    queryFn: () => api.getEntities({ days, limit: 100 }),
    enabled: !!config.apiEndpoint,
  })

  // Build dynamic sources list from entities
  const sources = useMemo(() => {
    if (!entitiesData?.entities?.sources) return ['all']
    const sourceNames = Object.keys(entitiesData.entities.sources)
      .sort((a, b) => (entitiesData.entities.sources[b] || 0) - (entitiesData.entities.sources[a] || 0))
    return ['all', ...sourceNames]
  }, [entitiesData])

  // Build dynamic categories list from entities
  const categories = useMemo(() => {
    if (!entitiesData?.entities?.categories) return defaultCategories
    const categoryNames = Object.keys(entitiesData.entities.categories)
      .sort((a, b) => (entitiesData.entities.categories[b] || 0) - (entitiesData.entities.categories[a] || 0))
    return ['all', ...categoryNames]
  }, [entitiesData])

  // Update URL when filters change
  useEffect(() => {
    const params = new URLSearchParams()
    if (search) params.set('q', search)
    if (sourceFilter !== 'all') params.set('source', sourceFilter)
    if (sentimentFilter !== 'all') params.set('sentiment', sentimentFilter)
    if (categoryFilter !== 'all') params.set('category', categoryFilter)
    setSearchParams(params, { replace: true })
  }, [search, sourceFilter, sentimentFilter, categoryFilter, setSearchParams])

  // Server-side search when search term is provided
  const { data: searchData, isLoading: searchLoading } = useQuery({
    queryKey: ['feedback-search', search, days],
    queryFn: () => api.searchFeedback({ q: search, days, limit: 100 }),
    enabled: !!config.apiEndpoint && search.length >= 2,
  })

  // Regular feedback query
  const { data, isLoading } = useQuery({
    queryKey: ['feedback', days, sourceFilter, sentimentFilter, categoryFilter, showUrgentOnly],
    queryFn: () => showUrgentOnly 
      ? api.getUrgentFeedback({ days, limit: 100 })
      : api.getFeedback({
          days,
          source: sourceFilter !== 'all' ? sourceFilter : undefined,
          sentiment: sentimentFilter !== 'all' ? sentimentFilter : undefined,
          category: categoryFilter !== 'all' ? categoryFilter : undefined,
          limit: 100,
        }),
    enabled: !!config.apiEndpoint && search.length < 2,
  })



  // Use search results if searching, otherwise use regular results
  const activeData = search.length >= 2 ? searchData : data
  const activeLoading = search.length >= 2 ? searchLoading : isLoading

  const filteredItems = activeData?.items || []

  const clearFilters = () => {
    setSearch('')
    setSourceFilter('all')
    setSentimentFilter('all')
    setCategoryFilter('all')
    setShowUrgentOnly(false)
  }

  const hasActiveFilters = search || sourceFilter !== 'all' || sentimentFilter !== 'all' || categoryFilter !== 'all' || showUrgentOnly

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Please configure your API endpoint in Settings</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Filters */}
      <div className="card !p-4 sm:!p-6">
        <div className="flex flex-col gap-3 sm:gap-4">
          {/* Search - full width on mobile */}
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={18} />
            <input
              type="text"
              placeholder="Search feedback..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input !pl-11"
            />
          </div>

          {/* Filter row - scrollable on mobile */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            {/* Source filter */}
            <div className="flex items-center gap-2 min-w-0">
              <Filter size={16} className="text-gray-400 flex-shrink-0 hidden sm:block" />
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="input w-full sm:w-auto text-sm"
              >
                {sources.map(s => (
                  <option key={s} value={s}>{s === 'all' ? 'All Sources' : s}</option>
                ))}
              </select>
            </div>

            {/* Sentiment filter */}
            <select
              value={sentimentFilter}
              onChange={(e) => setSentimentFilter(e.target.value)}
              className="input w-full sm:w-auto text-sm flex-1 sm:flex-none"
            >
              {sentiments.map(s => (
                <option key={s} value={s}>{s === 'all' ? 'All Sentiments' : s}</option>
              ))}
            </select>

            {/* Category filter */}
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="input w-full sm:w-auto text-sm flex-1 sm:flex-none"
            >
              {categories.map(c => (
                <option key={c} value={c}>{c === 'all' ? 'All Categories' : c.replace('_', ' ')}</option>
              ))}
            </select>

            {/* Urgent only toggle */}
            <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={showUrgentOnly}
                onChange={(e) => setShowUrgentOnly(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Urgent only</span>
            </label>
          </div>
        </div>
      </div>



      {/* Results count */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <p className="text-sm text-gray-500">
          Showing {filteredItems.length} of {activeData?.count || 0} items
          {search && <span className="ml-1">for "{search}"</span>}
        </p>
        <div className="flex items-center gap-3">
          {hasActiveFilters && (
            <button 
              onClick={clearFilters}
              className="flex items-center gap-1 text-sm text-red-600 hover:text-red-700"
            >
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

      {/* Feedback list */}
      {activeLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500">No feedback found matching your filters</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
          {filteredItems.map((item) => (
            <FeedbackCard key={item.feedback_id} feedback={item} />
          ))}
        </div>
      )}
    </div>
  )
}
