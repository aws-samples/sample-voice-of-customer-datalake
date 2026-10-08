/**
 * @fileoverview Analytics data (category/sentiment breakdowns, word cloud,
 * source list) for the Categories page. Extracted from the page component
 * to keep it under the ESLint complexity ceiling.
 * @module pages/Categories/useCategoryAnalytics
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { useCategoryAdmits } from '../../hooks/useCategories'
import type { DateRangeParams } from '../../api/client'
import { normalizeEntityExtras, rankedNames } from '../../api/dimensionsSchema'
import type { AttributeFilters } from '../../api/types'
import { rankEntityKeys } from './entityCounts'
import { NEUTRAL_CHART_STEP, categoryChartSteps, chartStepPrintHex } from './types'
import { sentimentHexColor } from '../../lib/sentiment'
import type { CategoryData, SentimentData, WordCloudItem } from './types'
import { failedReads, type FailedReads } from '../../utils/failedReads'

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

function buildWordCloudData(
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

/** `loadFailed`: the category or sentiment read failed with nothing cached (the cards would only show zeros). */
export interface CategoryAnalytics extends FailedReads {
  categoryData: CategoryData[]
  sentimentData: SentimentData[]
  wordCloudData: WordCloudItem[]
  allSources: string[]
  /** Channels and tags seen in the window (unfiltered), largest first — the filter options. */
  allChannels: string[]
  allTags: string[]
  totalIssues: number
  avgSentiment: number
  sentimentPercentages: Record<string, number>
  periodDays: number | undefined
  isLoading: boolean
}

/** The `source` query parameter for a selection: none (`null`) and the empty "all sources" value both mean unfiltered. */
function sourceFilter(selectedSource: string | null): string | undefined {
  return selectedSource === null || selectedSource === '' ? undefined : selectedSource
}

/** The unfiltered entities read, shared by both entity queries when no source is selected. */
function allSourcesEntitiesKey(dateParams: DateRangeParams): readonly unknown[] {
  return ['entities-all-sources', dateParams]
}

/**
 * `attributes` (channel / dims / tag) narrow the category, sentiment and
 * entities reads like `source` does; the all-sources entities read stays
 * unfiltered because it supplies the filter OPTIONS.
 */
export function useCategoryAnalytics(
  dateParams: DateRangeParams,
  selectedSource: string | null,
  apiEndpoint: string,
  attributes: AttributeFilters = {},
): CategoryAnalytics {
  const enabled = !!apiEndpoint
  const source = sourceFilter(selectedSource)
  const unfiltered = source === undefined && Object.keys(attributes).length === 0

  const categoriesQuery = useQuery({
    queryKey: ['categories', dateParams, selectedSource, attributes],
    queryFn: () => api.getCategories(dateParams, source, attributes),
    enabled,
  })
  const categories = categoriesQuery.data

  const sentimentQuery = useQuery({
    queryKey: ['sentiment', dateParams, selectedSource, attributes],
    queryFn: () => api.getSentiment(dateParams, source, attributes),
    enabled,
  })
  const sentiment = sentimentQuery.data

  // With no filter this is the SAME request as the all-sources read below, so
  // it shares that query's key and the page asks once, not twice
  // (production: two identical /feedback/entities calls, 1.1 s and 1.7 s).
  const { data: entities } = useQuery({
    queryKey: unfiltered ? allSourcesEntitiesKey(dateParams) : ['entities', dateParams, source, attributes],
    queryFn: () => api.getEntities({ ...dateParams, limit: 50, source, ...attributes }),
    enabled,
  })

  const { data: allEntities } = useQuery({
    queryKey: allSourcesEntitiesKey(dateParams),
    queryFn: () => api.getEntities({ ...dateParams, limit: 50 }),
    enabled,
  })

  const allSources = useMemo(() => rankEntityKeys(allEntities, 'sources'), [allEntities])
  const extras = useMemo(() => normalizeEntityExtras(allEntities), [allEntities])
  const allChannels = useMemo(() => rankedNames(extras.channels), [extras])
  const allTags = useMemo(() => rankedNames(extras.tags), [extras])

  // Belt-and-braces over the backend's per-category filtering: a category the
  // caller cannot see never becomes a filter chip, even from a stale cache.
  const admits = useCategoryAdmits()
  const categoryData: CategoryData[] = useMemo(() => {
    if (!categories) return []
    // Ranked largest first, ties by name, so the same counts always give the
    // same order — and therefore the same colours (colours are assigned by rank).
    const ranked = Object.entries(categories.categories)
      .filter(([name]) => admits(name))
      .sort(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB))
    const steps = categoryChartSteps(ranked.map(([name]) => name))
    return ranked.map(([name, value]) => ({
      name, value, color: chartStepPrintHex(steps.get(name) ?? NEUTRAL_CHART_STEP),
    }))
  }, [categories, admits])

  const sentimentData: SentimentData[] = useMemo(() => {
    if (!sentiment) return []
    return Object.entries(sentiment.breakdown).map(([name, value]) => ({
      name,
      value,
      color: sentimentHexColor(name),
      percentage: sentiment.percentages[name] ?? 0,
    }))
  }, [sentiment])

  const wordCloudData: WordCloudItem[] = useMemo(
    () => buildWordCloudData(entities?.entities),
    [entities]
  )

  const totalIssues = categoryData.reduce((sum, c) => sum + c.value, 0)
  // A label with no feedback may be absent from `percentages`; it counts as 0%
  // (a present 0 already is 0, so `??` and the old `||` agree on every JSON value).
  const avgSentiment = sentiment
    ? (sentiment.percentages.positive ?? 0) - (sentiment.percentages.negative ?? 0)
    : 0

  return {
    categoryData,
    sentimentData,
    wordCloudData,
    allSources,
    allChannels,
    allTags,
    totalIssues,
    avgSentiment,
    sentimentPercentages: sentiment?.percentages ?? {},
    periodDays: categories?.period_days,
    isLoading: categoriesQuery.isLoading || sentimentQuery.isLoading,
    ...failedReads([categoriesQuery, sentimentQuery]),
  }
}
