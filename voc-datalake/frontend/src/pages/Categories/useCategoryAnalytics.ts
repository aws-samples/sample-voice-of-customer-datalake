/**
 * @fileoverview Analytics data (category/sentiment breakdowns, word cloud,
 * source list) for the Categories page. Extracted from the page component
 * to keep it under the ESLint complexity ceiling.
 * @module pages/Categories/useCategoryAnalytics
 */

import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { CategoryBreakdown, DateRangeParams, SentimentBreakdown } from '../../api/client'
import { filtersKey, hasActiveFilters } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import { getMetricsOverview } from '../../api/metricsOverviewApi'
import type { MetricsOverview } from '../../api/metricsOverviewApi'
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
  /** Every source in the window with its item count (filter panel options). */
  sourceCounts: Record<string, number>
  totalIssues: number
  avgSentiment: number
  sentimentPercentages: Record<string, number>
  periodDays: number | undefined
  isLoading: boolean
  /** The cards show an earlier selection's numbers while the current one loads. */
  isUpdating: boolean
}

/**
 * The filters the analytics cards honour. Category and sentiment are left out on
 * purpose: the distribution card IS the category selector and the gauge legend
 * IS the sentiment control, so they must keep showing every option while the
 * feedback list below applies the full selection.
 */
export function analyticsFacetFilters(filters: FeedbackFilterState): FeedbackFilterState {
  return { ...filters, categories: [], sentiments: [] }
}

interface AnalyticsSources {
  categories: CategoryBreakdown | undefined
  sentiment: SentimentBreakdown | undefined
  entities: { issues?: Record<string, number>; categories?: Record<string, number> } | undefined
  isLoading: boolean
  /** Showing an earlier selection's numbers while the current one loads. */
  isUpdating: boolean
}

function fromOverview(data: MetricsOverview | undefined, isLoading: boolean, isUpdating: boolean): AnalyticsSources {
  return {
    categories: data?.categories,
    sentiment: data?.sentiment,
    entities: data && { issues: data.issues, categories: data.categories.categories },
    isLoading,
    isUpdating,
  }
}

/**
 * Unfiltered: the aggregate endpoints. Filtered: one overview scan.
 *
 * Neither path blanks the cards on a change: a filter change keeps the previous
 * scan's numbers (`keepPreviousData`), and the FIRST filter keeps the
 * unfiltered numbers — the aggregate queries are disabled then but still return
 * what they cached — both flagged `isUpdating` until the new scan lands.
 */
function useAnalyticsSources(
  dateParams: DateRangeParams, facetFilters: FeedbackFilterState, apiEndpoint: string,
): AnalyticsSources {
  const filtered = hasActiveFilters(facetFilters)
  const aggregate = !!apiEndpoint && !filtered

  const { data: categories, isLoading: categoriesLoading } = useQuery({
    queryKey: ['categories', dateParams, null],
    queryFn: () => api.getCategories(dateParams),
    enabled: aggregate,
  })
  const { data: sentiment, isLoading: sentimentLoading } = useQuery({
    queryKey: ['sentiment', dateParams, null],
    queryFn: () => api.getSentiment(dateParams),
    enabled: aggregate,
  })
  const { data: entities } = useQuery({
    queryKey: ['entities', dateParams, null],
    queryFn: () => api.getEntities({ ...dateParams, limit: 50 }),
    enabled: aggregate,
  })
  const overview = useQuery({
    queryKey: ['metrics-overview', dateParams, filtersKey(facetFilters)],
    queryFn: () => getMetricsOverview(dateParams, facetFilters),
    enabled: !!apiEndpoint && filtered,
    placeholderData: keepPreviousData,
  })

  const unfiltered: AnalyticsSources = {
    categories, sentiment, entities: entities?.entities,
    isLoading: categoriesLoading || sentimentLoading, isUpdating: false,
  }
  if (!filtered) return unfiltered
  if (overview.isLoading && categories !== undefined) return { ...unfiltered, isLoading: false, isUpdating: true }
  return fromOverview(overview.data, overview.isLoading, overview.isPlaceholderData)
}

export function useCategoryAnalytics(
  dateParams: DateRangeParams,
  facetFilters: FeedbackFilterState,
  apiEndpoint: string
): CategoryAnalytics {
  const enabled = !!apiEndpoint
  const { categories, sentiment, entities, isLoading, isUpdating } = useAnalyticsSources(dateParams, facetFilters, apiEndpoint)

  // Kept across window changes so the panel's source list never empties out.
  const { data: allEntities } = useQuery({
    queryKey: ['entities-all-sources', dateParams],
    queryFn: () => api.getEntities({ ...dateParams, limit: 50 }),
    enabled,
    placeholderData: keepPreviousData,
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
    () => buildWordCloudData(entities),
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
    sourceCounts: allEntities?.entities?.sources ?? {},
    totalIssues,
    avgSentiment,
    sentimentPercentages: sentiment?.percentages ?? {},
    periodDays: categories?.period_days,
    isLoading,
    isUpdating,
  }
}
