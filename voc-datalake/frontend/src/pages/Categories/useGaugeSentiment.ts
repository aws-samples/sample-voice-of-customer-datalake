/**
 * @fileoverview The sentiment the Categories gauge shows: the window's, or —
 * when exactly one category is selected — that category's own breakdown
 * (`/metrics/sentiment?category=`), so "Sentiment · Technical Support" never
 * shows the all-categories value.
 * @module pages/Categories/useGaugeSentiment
 */

import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { DateRangeParams } from '../../api/client'
import type { AttributeFilters, SentimentBreakdown } from '../../api/types'
import { sentimentHexColor } from '../../lib/sentiment'
import type { SentimentData } from './types'

/** One gauge slice per label the breakdown reported. */
export function toSentimentData(sentiment: SentimentBreakdown | undefined): SentimentData[] {
  if (!sentiment) return []
  return Object.entries(sentiment.breakdown).map(([name, value]) => ({
    name,
    value,
    color: sentimentHexColor(name),
    percentage: sentiment.percentages[name] ?? 0,
  }))
}

/** The one selected category, or null for none / several (several = the window's sentiment). */
export function gaugeScopeCategory(selectedCategories: readonly string[] | undefined): string | null {
  return selectedCategories?.length === 1 ? (selectedCategories[0] ?? null) : null
}

interface GaugeSentimentArgs {
  readonly dateParams: DateRangeParams
  readonly source: string | undefined
  readonly attributes: AttributeFilters
  /** Absent = none selected. */
  readonly selectedCategories: readonly string[] | undefined
  readonly enabled: boolean
  /** The window's breakdown (already read for the category totals). */
  readonly windowSentiment: SentimentBreakdown | undefined
}

export interface GaugeSentiment {
  /** The category the gauge is scoped to; null = every category. */
  readonly scopeCategory: string | null
  readonly sentimentData: SentimentData[]
  readonly percentages: Record<string, number>
  /** The scoped read has no answer yet (the gauge shows a skeleton, not a wrong value). */
  readonly isLoading: boolean
}

export function useGaugeSentiment({
  dateParams, source, attributes, selectedCategories, enabled, windowSentiment,
}: GaugeSentimentArgs): GaugeSentiment {
  const requested = gaugeScopeCategory(selectedCategories)
  const scopedQuery = useQuery({
    queryKey: ['sentiment', dateParams, source ?? null, attributes, { category: requested }],
    queryFn: () => api.getSentiment(dateParams, source, attributes, requested ?? undefined),
    enabled: enabled && requested !== null,
  })
  // A failed scoped read falls back to the window's breakdown, titled as such —
  // never a category title over the all-categories value.
  const scopeCategory = scopedQuery.isError ? null : requested
  const sentiment = scopeCategory === null ? windowSentiment : scopedQuery.data
  return {
    scopeCategory,
    sentimentData: toSentimentData(sentiment),
    percentages: sentiment?.percentages ?? {},
    isLoading: enabled && scopeCategory !== null && scopedQuery.isPending,
  }
}
