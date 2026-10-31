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
import type { ItemFilterParams } from '../../api/types'
import { rankEntityKeys } from './entityCounts'
import { NEUTRAL_CHART_STEP, categoryChartSteps, chartStepPrintHex } from './types'
import { toSentimentData, useGaugeSentiment, type GaugeSentiment } from './useGaugeSentiment'
import type { CategoryData, SentimentData, WordCloudItem } from './types'
import { failedReads, type FailedReads } from '../../utils/failedReads'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { rankCategoryEntries } from '../../utils/categoryOrder'
import { metricsKeys } from '../../api/queryKeys'

/**
 * Words that say nothing on their own in a review keyword cloud: English
 * function words plus review filler ("app", "issue", "problem", …). Words of
 * four letters or fewer are dropped by length already.
 */
const STOP_WORDS = new Set([
  'with', 'that', 'this', 'from', 'have', 'been', 'were', 'they', 'their', 'them', 'then', 'these', 'those',
  'about', 'would', 'could', 'should', 'very', 'more', 'some', 'than', 'also', 'just', 'only', 'even', 'much',
  'when', 'what', 'which', 'there', 'other', 'where', 'while', 'into', 'over', 'after', 'before', 'because',
  'really', 'still', 'every', 'being', 'does', 'doesnt', 'didnt', 'dont', 'cant', 'cannot', 'will', 'your',
  'users', 'user', 'issue', 'issues', 'problem', 'problems', 'thing', 'things', 'something', 'anything',
  'application', 'feature', 'features', 'experience', 'customer', 'customers', 'review', 'reviews',
])

/** `word` is worth a keyword chip: long enough, not filler, not the name of a category. */
function isValidWord(word: string, categoryWords: ReadonlySet<string>): boolean {
  return word.length > 3 && !STOP_WORDS.has(word) && !categoryWords.has(word)
}

/** Lower-case words of every category id and label: the distribution card already shows them. */
function categoryWordsOf(
  categories: Readonly<Record<string, number>> | undefined,
  label: (id: string) => string,
): ReadonlySet<string> {
  const ids = Object.keys(categories ?? {})
  const texts = [...ids, ...ids.map(label)]
  return new Set(texts.flatMap((text) => text.toLowerCase().split(/[^a-z]+/).filter(Boolean)))
}

function extractWordsFromIssues(issuesData: Record<string, number>, categoryWords: ReadonlySet<string>): Record<string, number> {
  const wordCounts: Record<string, number> = {}
  for (const [issue, count] of Object.entries(issuesData)) {
    const words = issue.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter((word) => isValidWord(word, categoryWords))
    const countNum = typeof count === 'number' ? count : 0
    for (const word of words) {
      wordCounts[word] = (wordCounts[word] ?? 0) + countNum
    }
  }
  return wordCounts
}

type WordCloudLabels = Readonly<{ category: (id: string) => string; keyword: (word: string) => string }>

/**
 * Trending keywords from the issue phrases. Category names are NOT keywords —
 * the distribution card beside it already ranks them — so the window's
 * categories and their words, and any word that is a configured category id
 * (`keyword` reads it as the category's name), are left out, as are stop words.
 */
function buildWordCloudData(
  entities: { issues?: Record<string, number>; categories?: Record<string, number> } | undefined,
  labels: WordCloudLabels,
): WordCloudItem[] {
  if (!entities) return []
  const wordCounts = extractWordsFromIssues(entities.issues ?? {}, categoryWordsOf(entities.categories, labels.category))
  return Object.entries(wordCounts)
    .filter(([word]) => labels.keyword(word) === word)
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
  /** Reviews in the window with no category (sentiment total − categorised), so the bars sum to the total. */
  uncategorised: number
  avgSentiment: number
  /** What the sentiment gauge shows: the window, or the one selected category. */
  gauge: GaugeSentiment
  periodDays: number | undefined
  isLoading: boolean
}

/** Reviews counted under a category, and the rest of the window's reviews (never below 0). */
function categoryTotals(categoryData: readonly CategoryData[], windowTotal: number | undefined) {
  const categorised = categoryData.reduce((sum, c) => sum + c.value, 0)
  return { categorised, uncategorised: Math.max(0, (windowTotal ?? 0) - categorised) }
}

/** The `source` query parameter for a selection: a comma list (any of them), or none for unfiltered. */
function sourceFilter(selectedSources: readonly string[]): string | undefined {
  return selectedSources.length === 0 ? undefined : selectedSources.join(',')
}

/** The unfiltered entities read, shared by both entity queries when no source is selected. */
function allSourcesEntitiesKey(dateParams: DateRangeParams): readonly unknown[] {
  return ['entities-all-sources', dateParams]
}

/**
 * `attributes` (channel / dims / tag, stars, urgent only) narrow the category, sentiment and
 * entities reads like `source` does; the all-sources entities read stays
 * unfiltered because it supplies the filter OPTIONS.
 */
export function useCategoryAnalytics(
  dateParams: DateRangeParams,
  selectedSources: readonly string[],
  apiEndpoint: string,
  attributes: ItemFilterParams = {},
  selectedCategories?: readonly string[],
): CategoryAnalytics {
  const enabled = !!apiEndpoint
  const source = sourceFilter(selectedSources)
  const unfiltered = source === undefined && Object.keys(attributes).length === 0

  const categoriesQuery = useQuery({
    queryKey: metricsKeys.categories(dateParams, source ?? null, attributes),
    queryFn: () => api.getCategories(dateParams, source, attributes),
    enabled,
  })
  const categories = categoriesQuery.data

  const sentimentQuery = useQuery({
    queryKey: metricsKeys.sentiment(dateParams, source ?? null, attributes),
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
    // "Other" (reviews outside the configured categories) is always last.
    const ranked = rankCategoryEntries(Object.entries(categories.categories).filter(([name]) => admits(name)))
    const steps = categoryChartSteps(ranked.map(([name]) => name))
    return ranked.map(([name, value]) => ({
      name, value, color: chartStepPrintHex(steps.get(name) ?? NEUTRAL_CHART_STEP),
    }))
  }, [categories, admits])

  const sentimentData: SentimentData[] = useMemo(() => toSentimentData(sentiment), [sentiment])
  const gauge = useGaugeSentiment({ dateParams, source, attributes, selectedCategories, enabled, windowSentiment: sentiment })

  const labels = useDisplayLabels()
  const wordCloudData: WordCloudItem[] = useMemo(
    () => buildWordCloudData(entities?.entities, labels),
    [entities, labels]
  )

  const { categorised, uncategorised } = categoryTotals(categoryData, sentiment?.total)
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
    totalIssues: categorised + uncategorised,
    uncategorised,
    avgSentiment,
    gauge,
    periodDays: categories?.period_days,
    isLoading: categoriesQuery.isLoading || sentimentQuery.isLoading,
    ...failedReads([categoriesQuery, sentimentQuery]),
  }
}
