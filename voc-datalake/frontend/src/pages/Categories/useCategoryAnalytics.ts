/**
 * @fileoverview Analytics data (category/sentiment breakdowns, word cloud,
 * source list) for the Categories page. Extracted from the page component
 * to keep it under the ESLint complexity ceiling.
 * @module pages/Categories/useCategoryAnalytics
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { DateRangeParams } from '../../api/client'
import { categoryColors, getSentimentColor } from './types'
import type { CategoryData, SentimentData, WordCloudItem } from './types'

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

export function buildWordCloudData(
  entities: { issues?: Record<string, number>; categories?: Record<string, number> } | undefined
): WordCloudItem[] {
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

export interface CategoryAnalytics {
  categoryData: CategoryData[]
  sentimentData: SentimentData[]
  wordCloudData: WordCloudItem[]
  allSources: string[]
  totalIssues: number
  avgSentiment: number
  sentimentPercentages: Record<string, number>
  periodDays: number | undefined
  isLoading: boolean
}

export function useCategoryAnalytics(
  dateParams: DateRangeParams,
  selectedSource: string | null,
  apiEndpoint: string
): CategoryAnalytics {
  const enabled = !!apiEndpoint

  const { data: categories, isLoading: categoriesLoading } = useQuery({
    queryKey: ['categories', dateParams, selectedSource],
    queryFn: () => api.getCategories(dateParams, selectedSource || undefined),
    enabled,
  })

  const { data: sentiment, isLoading: sentimentLoading } = useQuery({
    queryKey: ['sentiment', dateParams, selectedSource],
    queryFn: () => api.getSentiment(dateParams, selectedSource || undefined),
    enabled,
  })

  const { data: entities } = useQuery({
    queryKey: ['entities', dateParams, selectedSource],
    queryFn: () => api.getEntities({ ...dateParams, limit: 50, source: selectedSource || undefined }),
    enabled,
  })

  const { data: allEntities } = useQuery({
    queryKey: ['entities-all-sources', dateParams],
    queryFn: () => api.getEntities({ ...dateParams, limit: 50 }),
    enabled,
  })

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

  const totalIssues = categoryData.reduce((sum, c) => sum + c.value, 0)
  const avgSentiment = sentiment
    ? (sentiment.percentages.positive || 0) - (sentiment.percentages.negative || 0)
    : 0

  return {
    categoryData,
    sentimentData,
    wordCloudData,
    allSources,
    totalIssues,
    avgSentiment,
    sentimentPercentages: sentiment?.percentages ?? {},
    periodDays: categories?.period_days,
    isLoading: categoriesLoading || sentimentLoading,
  }
}
