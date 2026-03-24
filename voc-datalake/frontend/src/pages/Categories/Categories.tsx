/**
 * @fileoverview Categories analysis page with breakdown and filtering.
 * @module pages/Categories
 */

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, getDaysFromRange } from '../../api/client'
import type { FeedbackItem } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { categoryColors, getSentimentColor } from './types'
import type { SentimentFilter, ViewMode, CategoryData, SentimentData, WordCloudItem } from './types'
import { SourceFilter } from './SourceFilter'
import { InsightsRow } from './InsightsRow'
import { SentimentGauge } from './SentimentGaugeCard'
import { WordCloudCard } from './WordCloudCard'
import { CategorySelector } from './CategorySelector'
import { FeedbackResults } from './FeedbackResults'
import { generateCategoriesPDF } from './categoriesPdfGenerator'

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

function matchesFeedbackFilters(
  item: FeedbackItem,
  minRating: number,
  selectedCategories: string[],
  selectedSource: string | null,
  selectedKeywords: string[],
): boolean {
  if (minRating > 0 && (!item.rating || item.rating < minRating)) return false
  if (selectedCategories.length > 1 && !selectedCategories.includes(item.category)) return false
  if (selectedSource && item.brand_name !== selectedSource) return false
  if (selectedKeywords.length > 0) {
    const text = (item.original_text + ' ' + (item.problem_summary ?? '')).toLowerCase()
    if (!selectedKeywords.some(kw => text.includes(kw.toLowerCase()))) return false
  }
  return true
}

function exportFeedbackCSV(filteredFeedback: FeedbackItem[], allItems: FeedbackItem[]) {
  const dataToExport = filteredFeedback.length > 0 ? filteredFeedback : allItems
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

function computeAvgSentiment(sentiment: { percentages: Record<string, number> } | undefined): number {
  if (!sentiment) return 0
  return (sentiment.percentages.positive || 0) - (sentiment.percentages.negative || 0)
}

function safePDFExport<T>(exportFn: (data: T) => void, data: T): void {
  try {
    exportFn(data)
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('PDF export failed:', error)
    }
  }
}

function toggleArrayItem(arr: string[], item: string): string[] {
  return arr.includes(item) ? arr.filter(i => i !== item) : [...arr, item]
}

function buildFeedbackQueryParams(
  days: number,
  selectedSource: string | null,
  selectedCategories: string[],
  sentimentFilter: SentimentFilter,
) {
  return {
    days,
    source: selectedSource || undefined,
    category: selectedCategories.length === 1 ? selectedCategories[0] : undefined,
    sentiment: sentimentFilter !== 'all' ? sentimentFilter : undefined,
    limit: 100,
  }
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
    queryFn: () => api.getFeedback(
      buildFeedbackQueryParams(days, selectedSource, selectedCategories, sentimentFilter)
    ),
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
    return feedbackData.items.filter(item =>
      matchesFeedbackFilters(item, minRating, selectedCategories, selectedSource, selectedKeywords)
    )
  }, [feedbackData, minRating, selectedCategories, selectedKeywords, selectedSource])

  // Handlers
  const toggleCategory = (category: string) => {
    setSelectedCategories(prev => toggleArrayItem(prev, category))
  }

  const toggleKeyword = (keyword: string) => {
    setSelectedKeywords(prev => toggleArrayItem(prev, keyword))
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
    exportFeedbackCSV(filteredFeedback, feedbackData?.items || [])
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

  const avgSentiment = computeAvgSentiment(sentiment)

  const exportPDF = () => {
    safePDFExport(generateCategoriesPDF, {
      categoryData,
      sentimentData,
      wordCloudData,
      totalIssues,
      avgSentiment,
      timeRange,
      selectedSource,
    })
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-start">
        <div className="flex-1">
          <SourceFilter selectedSource={selectedSource} onSourceChange={setSelectedSource} allSources={allSources} />
        </div>
        {categoryData.length > 0 && (
          <button
            onClick={exportPDF}
            className="btn btn-secondary text-xs sm:text-sm px-3 py-2 sm:py-2.5 active:scale-95 flex items-center gap-1.5 whitespace-nowrap self-start"
            title="Export as PDF"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            PDF
          </button>
        )}
      </div>
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
