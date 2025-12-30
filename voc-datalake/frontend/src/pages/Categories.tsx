/**
 * @fileoverview Categories analysis page with breakdown and filtering.
 *
 * Features:
 * - Category distribution pie chart
 * - Multi-select category and keyword filtering
 * - Sentiment and rating filters
 * - Grid/list view toggle for feedback items
 * - Source-specific filtering
 *
 * @module pages/Categories
 */

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { 
  TrendingDown, TrendingUp, Download, X, Star, Filter,
  ChevronDown, LayoutGrid, List
} from 'lucide-react'
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import FeedbackCard from '../components/FeedbackCard'
import clsx from 'clsx'

/**
 * Color mapping for feedback categories.
 * Each category is assigned a distinct color for visual differentiation in charts and badges.
 * @constant
 */
const categoryColors: Record<string, string> = {
  // Airline/travel categories
  flight_operations: '#ef4444',
  in_flight_experience: '#f97316',
  customer_service: '#eab308',
  baggage_handling: '#22c55e',
  booking_and_check_in: '#3b82f6',
  pricing_and_fees: '#8b5cf6',
  loyalty_program: '#ec4899',
  airport_facilities: '#14b8a6',
  // Legacy/default categories
  delivery: '#ef4444',
  customer_support: '#f97316',
  product_quality: '#eab308',
  pricing: '#22c55e',
  website: '#3b82f6',
  app: '#8b5cf6',
  billing: '#ec4899',
  returns: '#14b8a6',
  communication: '#6366f1',
  other: '#6b7280',
}

/**
 * Color mapping for sentiment labels.
 * Used in sentiment gauge and badges throughout the page.
 * @constant
 */
const sentimentColors = {
  positive: '#22c55e',
  neutral: '#6b7280', 
  negative: '#ef4444',
  mixed: '#eab308',
}

/**
 * Display mode for feedback items.
 * @typedef {'grid' | 'list'} ViewMode
 */
type ViewMode = 'grid' | 'list'

/**
 * Filter options for sentiment-based filtering.
 * @typedef {'all' | 'positive' | 'negative' | 'neutral' | 'mixed'} SentimentFilter
 */
type SentimentFilter = 'all' | 'positive' | 'negative' | 'neutral' | 'mixed'

/**
 * Categories analysis page component.
 *
 * Provides comprehensive category breakdown and filtering capabilities for feedback analysis.
 * Includes sentiment gauge visualization, trending keywords word cloud, and filterable
 * feedback list with grid/list view options.
 *
 * @returns {JSX.Element} The rendered Categories page
 *
 * @example
 * // Used in router configuration
 * <Route path="/categories" element={<Categories />} />
 */
export default function Categories() {
  const { timeRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange)
  
  // State
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([])
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>('all')
  const [minRating, setMinRating] = useState<number>(0)
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [showFilters, setShowFilters] = useState(false)

  // Queries - pass source filter to all data queries
  const { data: categories, isLoading: categoriesLoading } = useQuery({
    queryKey: ['categories', days, selectedSource],
    queryFn: () => api.getCategories(days, selectedSource || undefined),
    enabled: !!config.apiEndpoint,
  })

  const { data: sentiment, isLoading: sentimentLoading } = useQuery({
    queryKey: ['sentiment', days, selectedSource],
    queryFn: () => api.getSentiment(days, selectedSource || undefined),
    enabled: !!config.apiEndpoint,
  })

  const { data: entities } = useQuery({
    queryKey: ['entities', days, selectedSource],
    queryFn: () => api.getEntities({ days, limit: 50, source: selectedSource || undefined }),
    enabled: !!config.apiEndpoint,
  })

  // Fetch all sources (without source filter) for the dropdown
  const { data: allEntities } = useQuery({
    queryKey: ['entities-all-sources', days],
    queryFn: () => api.getEntities({ days, limit: 50 }),
    enabled: !!config.apiEndpoint,
  })

  // Build dynamic sources list from all entities (not filtered by source)
  const allSources = useMemo(() => {
    if (!allEntities?.entities?.sources) return []
    return Object.keys(allEntities.entities.sources)
      .sort((a, b) => (allEntities.entities.sources[b] || 0) - (allEntities.entities.sources[a] || 0))
  }, [allEntities])

  // Determine if we should fetch feedback (categories or keywords selected)
  const shouldFetchFeedback = selectedCategories.length > 0 || selectedKeywords.length > 0

  const { data: feedbackData, isLoading: feedbackLoading } = useQuery({
    queryKey: ['feedback', days, selectedCategories, sentimentFilter, selectedKeywords, selectedSource],
    queryFn: () => api.getFeedback({ 
      days, 
      source: selectedSource || undefined,
      category: selectedCategories.length === 1 ? selectedCategories[0] : undefined,
      sentiment: sentimentFilter !== 'all' ? sentimentFilter : undefined,
      limit: 100 
    }),
    enabled: !!config.apiEndpoint && shouldFetchFeedback,
  })

  // Computed data
  const categoryData = useMemo(() => {
    if (!categories) return []
    return Object.entries(categories.categories)
      .map(([name, value]) => ({ 
        name, 
        value,
        color: categoryColors[name] || categoryColors.other
      }))
      .sort((a, b) => b.value - a.value)
  }, [categories])

  const totalIssues = categoryData.reduce((sum, c) => sum + c.value, 0)

  const sentimentData = useMemo(() => {
    if (!sentiment) return []
    return Object.entries(sentiment.breakdown).map(([name, value]) => ({
      name,
      value,
      color: sentimentColors[name as keyof typeof sentimentColors] || '#6b7280',
      percentage: sentiment.percentages[name] || 0
    }))
  }, [sentiment])

  // Word cloud data from entities - use issues (problem summaries) since keywords is empty
  const wordCloudData = useMemo(() => {
    if (!entities?.entities) return []
    // Try issues first (problem summaries), fall back to categories
    const issuesData = entities.entities.issues || {}
    const categoriesData = entities.entities.categories || {}
    
    // Combine issues and extract key words from them
    const wordCounts: Record<string, number> = {}
    
    // Extract words from issue summaries
    Object.entries(issuesData).forEach(([issue, count]) => {
      // Split issue into words and count meaningful ones
      const words = issue.toLowerCase()
        .replace(/[^a-z\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !['with', 'that', 'this', 'from', 'have', 'been', 'were', 'they', 'their', 'about', 'would', 'could', 'should', 'very', 'more', 'some', 'than', 'when', 'what', 'which', 'there', 'other'].includes(w))
      
      words.forEach(word => {
        wordCounts[word] = (wordCounts[word] || 0) + (count as number)
      })
    })
    
    // Add categories as words too
    Object.entries(categoriesData).forEach(([cat, count]) => {
      const word = cat.replace('_', ' ')
      wordCounts[word] = (wordCounts[word] || 0) + (count as number)
    })
    
    return Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([word, count]) => ({ word, count }))
  }, [entities])

  // Filter feedback by rating, categories, keywords, and source
  const filteredFeedback = useMemo(() => {
    if (!feedbackData?.items) return []
    return feedbackData.items.filter(item => {
      if (minRating > 0 && (!item.rating || item.rating < minRating)) return false
      if (selectedCategories.length > 1 && !selectedCategories.includes(item.category)) return false
      // Filter by source
      if (selectedSource && item.brand_name !== selectedSource) return false
      // Filter by keywords - check if feedback text contains any selected keyword
      if (selectedKeywords.length > 0) {
        const text = (item.original_text + ' ' + (item.problem_summary || '')).toLowerCase()
        const hasKeyword = selectedKeywords.some(kw => text.includes(kw.toLowerCase()))
        if (!hasKeyword) return false
      }
      return true
    })
  }, [feedbackData, minRating, selectedCategories, selectedKeywords, selectedSource])

  // Handlers
  const toggleCategory = (category: string) => {
    setSelectedCategories(prev => 
      prev.includes(category) 
        ? prev.filter(c => c !== category)
        : [...prev, category]
    )
  }

  const toggleKeyword = (keyword: string) => {
    setSelectedKeywords(prev => 
      prev.includes(keyword) 
        ? prev.filter(k => k !== keyword)
        : [...prev, keyword]
    )
  }

  const clearFilters = () => {
    setSelectedCategories([])
    setSelectedKeywords([])
    setSelectedSource(null)
    setSentimentFilter('all')
    setMinRating(0)
  }

  const hasActiveFilters = selectedCategories.length > 0 || selectedKeywords.length > 0 || selectedSource !== null || sentimentFilter !== 'all' || minRating > 0

  const exportData = () => {
    const dataToExport = filteredFeedback.length > 0 ? filteredFeedback : feedbackData?.items || []
    const csv = [
      ['ID', 'Source', 'Category', 'Sentiment', 'Rating', 'Text', 'Date'].join(','),
      ...dataToExport.map(item => [
        item.feedback_id,
        item.source_platform,
        item.category,
        item.sentiment_label,
        item.rating || '',
        `"${item.original_text.replace(/"/g, '""')}"`,
        item.source_created_at
      ].join(','))
    ].join('\n')
    
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `feedback-export-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
  }

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Please configure your API endpoint in Settings</p>
      </div>
    )
  }

  const isLoading = categoriesLoading || sentimentLoading

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  const avgSentiment = sentiment ? 
    (sentiment.percentages.positive || 0) - (sentiment.percentages.negative || 0) : 0

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Global Source Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 p-3 sm:p-4 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center gap-2">
          <Filter size={18} className="text-gray-500 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-700 whitespace-nowrap">Filter by Source:</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <select
            value={selectedSource || ''}
            onChange={(e) => setSelectedSource(e.target.value || null)}
            className="flex-1 sm:flex-none px-3 sm:px-4 py-2 border border-gray-300 rounded-lg text-sm bg-white min-w-0 sm:min-w-[200px] focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">All Sources</option>
            {allSources.map(source => (
              <option key={source} value={source}>{source}</option>
            ))}
          </select>
          {selectedSource && (
            <button
              onClick={() => setSelectedSource(null)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors active:scale-95"
            >
              <X size={14} />
              Clear
            </button>
          )}
        </div>
        {selectedSource && (
          <span className="text-xs sm:text-sm text-blue-600 bg-blue-50 px-3 py-1 rounded-full truncate">
            {selectedSource}
          </span>
        )}
      </div>

      {/* Key Insights Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <div className="bg-gradient-to-br from-red-50 to-red-100 rounded-xl p-3 sm:p-4 border border-red-200">
          <div className="flex items-center gap-2 text-red-700 mb-1 sm:mb-2">
            <TrendingUp size={16} className="sm:w-[18px] sm:h-[18px]" />
            <span className="text-xs sm:text-sm font-medium">Top Issue</span>
          </div>
          <p className="text-lg sm:text-xl font-bold text-red-900 capitalize truncate">
            {categoryData[0]?.name.replace('_', ' ') || 'N/A'}
          </p>
          <p className="text-xs sm:text-sm text-red-600">
            {categoryData[0]?.value || 0} issues ({((categoryData[0]?.value || 0) / totalIssues * 100).toFixed(0)}%)
          </p>
        </div>
        
        <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-xl p-3 sm:p-4 border border-green-200">
          <div className="flex items-center gap-2 text-green-700 mb-1 sm:mb-2">
            <TrendingDown size={16} className="sm:w-[18px] sm:h-[18px]" />
            <span className="text-xs sm:text-sm font-medium">Least Issues</span>
          </div>
          <p className="text-lg sm:text-xl font-bold text-green-900 capitalize truncate">
            {categoryData[categoryData.length - 1]?.name.replace('_', ' ') || 'N/A'}
          </p>
          <p className="text-xs sm:text-sm text-green-600">
            {categoryData[categoryData.length - 1]?.value || 0} issues
          </p>
        </div>
        
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-3 sm:p-4 border border-blue-200 sm:col-span-2 lg:col-span-1">
          <div className="flex items-center gap-2 text-blue-700 mb-1 sm:mb-2">
            <span className="text-xs sm:text-sm font-medium">Total Feedback</span>
          </div>
          <p className="text-lg sm:text-xl font-bold text-blue-900">{totalIssues}</p>
          <p className="text-xs sm:text-sm text-blue-600">{categoryData.length} categories</p>
        </div>
      </div>

      {/* Main Content: Sentiment Gauge + Word Cloud */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* Sentiment Gauge - Centerpiece */}
        <div className="card">
          <h2 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Overall Sentiment</h2>
          <div className="flex items-center justify-center">
            <div className="relative w-full max-w-[280px]">
              <ResponsiveContainer width="100%" height={160} className="sm:!h-[200px]">
                <PieChart>
                  <Pie
                    data={sentimentData}
                    cx="50%"
                    cy="100%"
                    startAngle={180}
                    endAngle={0}
                    innerRadius="55%"
                    outerRadius="85%"
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {sentimentData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip 
                    formatter={(value, name) => [
                      `${value} (${sentiment?.percentages[name as string]?.toFixed(1)}%)`, 
                      name
                    ]}
                  />
                </PieChart>
              </ResponsiveContainer>
              {/* Center score */}
              <div className="absolute inset-0 flex items-end justify-center pb-2 sm:pb-4">
                <div className="text-center">
                  <p className={clsx(
                    'text-2xl sm:text-3xl font-bold',
                    avgSentiment > 20 ? 'text-green-600' : avgSentiment < -20 ? 'text-red-600' : 'text-gray-600'
                  )}>
                    {avgSentiment > 0 ? '+' : ''}{avgSentiment.toFixed(0)}
                  </p>
                  <p className="text-xs text-gray-500">Net Sentiment</p>
                </div>
              </div>
            </div>
          </div>
          {/* Sentiment legend */}
          <div className="flex flex-wrap justify-center gap-2 sm:gap-4 mt-3 sm:mt-4">
            {sentimentData.map(s => (
              <button
                key={s.name}
                onClick={() => setSentimentFilter(sentimentFilter === s.name ? 'all' : s.name as SentimentFilter)}
                className={clsx(
                  'flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-xs sm:text-sm transition-all active:scale-95',
                  sentimentFilter === s.name 
                    ? 'bg-gray-900 text-white' 
                    : 'bg-gray-100 hover:bg-gray-200'
                )}
              >
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                <span className="capitalize">{s.name}</span>
                <span className="text-xs opacity-70">{s.percentage.toFixed(0)}%</span>
              </button>
            ))}
          </div>
        </div>

        {/* Word Cloud */}
        <div className="card">
          <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
            <h2 className="text-base sm:text-lg font-semibold">Trending Keywords</h2>
            {selectedKeywords.length > 0 && (
              <button
                onClick={() => setSelectedKeywords([])}
                className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 whitespace-nowrap"
              >
                <X size={12} />
                Clear ({selectedKeywords.length})
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 sm:gap-2 justify-center items-center min-h-[150px] sm:min-h-[200px]">
            {wordCloudData.map(({ word, count }) => {
              const maxCount = Math.max(...wordCloudData.map(w => w.count))
              const size = 0.65 + (count / maxCount) * 0.6
              const isSelected = selectedKeywords.includes(word)
              return (
                <button
                  key={word}
                  onClick={() => toggleKeyword(word)}
                  className={clsx(
                    'px-1.5 sm:px-2 py-0.5 sm:py-1 rounded transition-all cursor-pointer active:scale-95',
                    isSelected 
                      ? 'bg-blue-600 text-white ring-2 ring-blue-300 shadow-md' 
                      : 'bg-blue-100 text-blue-800 hover:bg-blue-200 sm:hover:scale-105'
                  )}
                  style={{ fontSize: `${size}rem` }}
                  title={`${count} mentions - click to filter`}
                >
                  {word}
                </button>
              )
            })}
            {wordCloudData.length === 0 && (
              <p className="text-gray-400 text-xs sm:text-sm">No keyword data available</p>
            )}
          </div>
          {selectedKeywords.length > 0 && (
            <p className="text-xs text-center text-gray-500 mt-2 sm:mt-3 line-clamp-2">
              Filtering by: {selectedKeywords.join(', ')}
            </p>
          )}
        </div>
      </div>

      {/* Category Selection */}
      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 sm:mb-4">
          <h2 className="text-base sm:text-lg font-semibold">Select Categories to Explore</h2>
          <div className="flex items-center gap-2">
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-xs sm:text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
              >
                <X size={14} />
                <span className="hidden xs:inline">Clear filters</span>
                <span className="xs:hidden">Clear</span>
              </button>
            )}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={clsx(
                'flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm transition-colors active:scale-95',
                showFilters ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 hover:bg-gray-200'
              )}
            >
              <Filter size={14} />
              <span className="hidden xs:inline">Filters</span>
              <ChevronDown size={14} className={clsx('transition-transform', showFilters && 'rotate-180')} />
            </button>
          </div>
        </div>

        {/* Advanced Filters */}
        {showFilters && (
          <div className="mb-3 sm:mb-4 p-3 sm:p-4 bg-gray-50 rounded-lg flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Min Rating</label>
              <div className="flex gap-0.5 sm:gap-1">
                {[0, 1, 2, 3, 4, 5].map(rating => (
                  <button
                    key={rating}
                    onClick={() => setMinRating(rating)}
                    className={clsx(
                      'p-1 sm:p-1.5 rounded transition-colors active:scale-95',
                      minRating === rating ? 'bg-yellow-100' : 'hover:bg-gray-200'
                    )}
                  >
                    {rating === 0 ? (
                      <span className="text-xs text-gray-500 px-1">Any</span>
                    ) : (
                      <Star size={14} className="sm:w-4 sm:h-4" fill={minRating >= rating ? '#eab308' : 'none'} color={minRating >= rating ? '#eab308' : '#d1d5db'} />
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Sentiment</label>
              <select
                value={sentimentFilter}
                onChange={(e) => setSentimentFilter(e.target.value as SentimentFilter)}
                className="px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm w-full sm:w-auto"
              >
                <option value="all">All Sentiments</option>
                <option value="positive">Positive</option>
                <option value="neutral">Neutral</option>
                <option value="negative">Negative</option>
                <option value="mixed">Mixed</option>
              </select>
            </div>
          </div>
        )}

        {/* Category Chips */}
        <div className="flex flex-wrap gap-1.5 sm:gap-2">
          {categoryData.map((category) => {
            const isSelected = selectedCategories.includes(category.name)
            const percentage = ((category.value / totalIssues) * 100).toFixed(1)
            
            return (
              <button
                key={category.name}
                onClick={() => toggleCategory(category.name)}
                className={clsx(
                  'flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-1.5 sm:py-2 rounded-full border-2 transition-all text-xs sm:text-sm active:scale-95',
                  isSelected 
                    ? 'border-blue-500 bg-blue-50 shadow-sm' 
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                )}
              >
                <span 
                  className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full flex-shrink-0" 
                  style={{ backgroundColor: category.color }}
                />
                <span className="font-medium capitalize truncate max-w-[100px] sm:max-w-none">{category.name.replace('_', ' ')}</span>
                <span className="text-gray-500">{category.value}</span>
                <span className="text-gray-400 hidden xs:inline">({percentage}%)</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Feedback Results */}
      {shouldFetchFeedback && (
        <div className="card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 sm:mb-4">
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold">
                Feedback Results
                <span className="ml-2 text-sm font-normal text-gray-500">
                  ({filteredFeedback.length})
                </span>
              </h2>
              <p className="text-xs sm:text-sm text-gray-500 truncate">
                {selectedSource && `Source: ${selectedSource}`}
                {selectedCategories.length > 0 && `${selectedSource ? ' • ' : ''}${selectedCategories.map(c => c.replace('_', ' ')).join(', ')}`}
                {selectedKeywords.length > 0 && `${selectedSource || selectedCategories.length > 0 ? ' • ' : ''}${selectedKeywords.join(', ')}`}
                {sentimentFilter !== 'all' && ` • ${sentimentFilter}`}
                {minRating > 0 && ` • ${minRating}+ stars`}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <div className="flex bg-gray-100 rounded-lg p-0.5 sm:p-1">
                <button
                  onClick={() => setViewMode('grid')}
                  className={clsx(
                    'p-1.5 rounded active:scale-95',
                    viewMode === 'grid' ? 'bg-white shadow-sm' : 'hover:bg-gray-200'
                  )}
                  aria-label="Grid view"
                >
                  <LayoutGrid size={14} className="sm:w-4 sm:h-4" />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={clsx(
                    'p-1.5 rounded active:scale-95',
                    viewMode === 'list' ? 'bg-white shadow-sm' : 'hover:bg-gray-200'
                  )}
                  aria-label="List view"
                >
                  <List size={14} className="sm:w-4 sm:h-4" />
                </button>
              </div>
              <button
                onClick={exportData}
                className="btn btn-secondary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2.5 sm:px-3 py-1.5"
              >
                <Download size={14} className="sm:w-4 sm:h-4" />
                <span className="hidden xs:inline">Export</span>
              </button>
            </div>
          </div>

          {feedbackLoading ? (
            <div className="flex items-center justify-center py-8 sm:py-12">
              <div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : filteredFeedback.length === 0 ? (
            <p className="text-gray-500 text-center py-8 sm:py-12 text-sm">No feedback found matching your filters</p>
          ) : (
            <div className={clsx(
              viewMode === 'grid' 
                ? 'grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4' 
                : 'space-y-2 sm:space-y-3'
            )}>
              {filteredFeedback.map((item) => (
                <FeedbackCard 
                  key={item.feedback_id} 
                  feedback={item} 
                  compact={viewMode === 'list'}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
