/**
 * @fileoverview Categories analysis page with breakdown and filtering.
 * @module pages/Categories
 */

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, getDaysFromRange } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { categoryColors, getSentimentColor } from './types'
import type { SentimentFilter, ViewMode, CategoryData, SentimentData, WordCloudItem } from './types'
import { SourceFilter } from './SourceFilter'
import { InsightsRow } from './InsightsRow'
import { SentimentGauge } from './SentimentGaugeCard'
import { WordCloudCard } from './WordCloudCard'
import { CategorySelector } from './CategorySelector'
import { FeedbackResults } from './FeedbackResults'

// Stop words for word cloud filtering
const STOP_WORDS = new Set([
  'with', 'that', 'this', 'from', 'have', 'been', 'were', 'they', 'their',
  'about', 'would', 'could', 'should', 'very', 'more', 'some', 'than',
  'when', 'what', 'which', 'there', 'other'
])

function isValidWord(word: string): boolean {
  return word.length > 3 && !STOP_WORDS.has(word)
}

function extractWordsFromIssues(issuesData: Record<string, number>): Record<string, number> {
  const wordCounts: Record<string, number> = {}
  for (const [issue, count] of Object.entries(issuesData)) {
    const words = issue.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(isValidWord)
    const countNum = typeof count === 'number' ? count : 0
    for (const word of words) {
      wordCounts[word] = (wordCounts[word] ?? 0) + countNum
    }
  }
  return wordCounts
}

function buildWordCloudData(entities: { issues?: Record<string, number>; categories?: Record<string, number> } | undefined): WordCloudItem[] {
  if (!entities) return []
  const wordCounts = extractWordsFromIssues(entities.issues ?? {})

  for (const [cat, count] of Object.entries(entities.categories ?? {})) {
    const word = cat.replace('_', ' ')
    const countNum = typeof count === 'number' ? count : 0
    wordCounts[word] = (wordCounts[word] ?? 0) + countNum
  }

  return Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word, count]) => ({ word, count }))
}

interface FilterState {
  selectedCategories: string[]
  selectedKeywords: string[]
  selectedSource: string | null
  sentimentFilter: SentimentFilter
  minRating: number
}

function checkHasActiveFilters(filters: FilterState): boolean {
  return (
    filters.selectedCategories.length > 0 ||
    filters.selectedKeywords.length > 0 ||
    filters.selectedSource !== null ||
    filters.sentimentFilter !== 'all' ||
    filters.minRating > 0
  )
}

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

  // Queries
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

  const { data: allEntities } = useQuery({
    queryKey: ['entities-all-sources', days],
    queryFn: () => api.getEntities({ days, limit: 50 }),
    enabled: !!config.apiEndpoint,
  })

  const shouldFetchFeedback = selectedCategories.length > 0 || selectedKeywords.length > 0

  const { data: feedbackData, isLoading: feedbackLoading } = useQuery({
    queryKey: ['feedback', days, selectedCategories, sentimentFilter, selectedKeywords, selectedSource],
    queryFn: () => api.getFeedback({
      days,
      source: selectedSource || undefined,
      category: selectedCategories.length === 1 ? selectedCategories[0] : undefined,
      sentiment: sentimentFilter !== 'all' ? sentimentFilter : undefined,
      limit: 100,
    }),
    enabled: !!config.apiEndpoint && shouldFetchFeedback,
  })

  // Computed data
  const allSources = useMemo(() => {
    if (!allEntities?.entities?.sources) return []
    return Object.keys(allEntities.entities.sources).sort(
      (a, b) => (allEntities.entities.sources[b] || 0) - (allEntities.entities.sources[a] || 0)
    )
  }, [allEntities])

  const categoryData: CategoryData[] = useMemo(() => {
    if (!categories) return []
    return Object.entries(categories.categories)
      .map(([name, value]) => ({ name, value, color: categoryColors[name] || categoryColors.other }))
      .sort((a, b) => b.value - a.value)
  }, [categories])

  const totalIssues = categoryData.reduce((sum, c) => sum + c.value, 0)

  const sentimentData: SentimentData[] = useMemo(() => {
    if (!sentiment) return []
    return Object.entries(sentiment.breakdown).map(([name, value]) => ({
      name,
      value,
      color: getSentimentColor(name),
      percentage: sentiment.percentages[name] ?? 0,
    }))
  }, [sentiment])

  const wordCloudData: WordCloudItem[] = useMemo(
    () => buildWordCloudData(entities?.entities),
    [entities]
  )

  const filteredFeedback = useMemo(() => {
    if (!feedbackData?.items) return []
    return feedbackData.items.filter(item => {
      const failsRatingFilter = minRating > 0 && (!item.rating || item.rating < minRating)
      if (failsRatingFilter) return false
      
      const failsCategoryFilter = selectedCategories.length > 1 && !selectedCategories.includes(item.category)
      if (failsCategoryFilter) return false
      
      const failsSourceFilter = selectedSource && item.brand_name !== selectedSource
      if (failsSourceFilter) return false
      
      if (selectedKeywords.length > 0) {
        const text = (item.original_text + ' ' + (item.problem_summary ?? '')).toLowerCase()
        const hasKeyword = selectedKeywords.some(kw => text.includes(kw.toLowerCase()))
        if (!hasKeyword) return false
      }
      return true
    })
  }, [feedbackData, minRating, selectedCategories, selectedKeywords, selectedSource])

  // Handlers
  const toggleCategory = (category: string) => {
    setSelectedCategories(prev => prev.includes(category) ? prev.filter(c => c !== category) : [...prev, category])
  }

  const toggleKeyword = (keyword: string) => {
    setSelectedKeywords(prev => prev.includes(keyword) ? prev.filter(k => k !== keyword) : [...prev, keyword])
  }

  const clearFilters = () => {
    setSelectedCategories([])
    setSelectedKeywords([])
    setSelectedSource(null)
    setSentimentFilter('all')
    setMinRating(0)
  }

  const hasActiveFilters = checkHasActiveFilters({
    selectedCategories,
    selectedKeywords,
    selectedSource,
    sentimentFilter,
    minRating,
  })

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
        item.source_created_at,
      ].join(',')),
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

  if (categoriesLoading || sentimentLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  const avgSentiment = sentiment ? (sentiment.percentages.positive || 0) - (sentiment.percentages.negative || 0) : 0

  return (
    <div className="space-y-4 sm:space-y-6">
      <SourceFilter selectedSource={selectedSource} onSourceChange={setSelectedSource} allSources={allSources} />
      <InsightsRow categoryData={categoryData} totalIssues={totalIssues} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <SentimentGauge
          sentimentData={sentimentData}
          avgSentiment={avgSentiment}
          sentimentFilter={sentimentFilter}
          onSentimentFilterChange={setSentimentFilter}
          percentages={sentiment?.percentages || {}}
        />
        <WordCloudCard
          wordCloudData={wordCloudData}
          selectedKeywords={selectedKeywords}
          onToggleKeyword={toggleKeyword}
          onClearKeywords={() => setSelectedKeywords([])}
        />
      </div>

      <CategorySelector
        categoryData={categoryData}
        totalIssues={totalIssues}
        selectedCategories={selectedCategories}
        onToggleCategory={toggleCategory}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={clearFilters}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters(!showFilters)}
        minRating={minRating}
        onMinRatingChange={setMinRating}
        sentimentFilter={sentimentFilter}
        onSentimentFilterChange={setSentimentFilter}
      />

      {shouldFetchFeedback && (
        <FeedbackResults
          filteredFeedback={filteredFeedback}
          feedbackLoading={feedbackLoading}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          selectedSource={selectedSource}
          selectedCategories={selectedCategories}
          selectedKeywords={selectedKeywords}
          sentimentFilter={sentimentFilter}
          minRating={minRating}
          onExport={exportData}
        />
      )}
    </div>
  )
}
