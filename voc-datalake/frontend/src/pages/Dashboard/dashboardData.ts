/**
 * @fileoverview Pure shaping of the dashboard's API data for its charts and PDF export.
 * @module pages/Dashboard/dashboardData
 */
import type { TFunction } from 'i18next'
import type { MetricsSummary, SentimentBreakdown, CategoryBreakdown, SourceBreakdown, FeedbackItem } from '../../api/types'

/**
 * The lower-bound hint for partial counts. A walk stopped by its time budget
 * names the oldest day it reached; every other cause gets the generic hint.
 */
export function partialHintText(isPartial: boolean, scannedThrough: string | null, t: TFunction): string | undefined {
  if (!isPartial) return undefined
  if (scannedThrough === null) return t('common:partialCountsHint')
  return t('common:partialTimeBudgetHint', { date: scannedThrough })
}

export function prepareSourceData(sources: SourceBreakdown | undefined) {
  if (!sources) return []
  return Object.entries(sources.sources)
    .map(([name, value]) => ({ name: name.replace('_', ' '), value }))
}

interface PDFExportInput {
  summary: MetricsSummary | undefined
  sentiment: SentimentBreakdown | undefined
  categories: CategoryBreakdown | undefined
  sources: SourceBreakdown | undefined
  urgentFeedback: { items?: FeedbackItem[]; count?: number } | undefined
  timeRange: string
  sourcesCount: number
}

function buildSentimentEntries(sentiment: SentimentBreakdown | undefined) {
  if (!sentiment) return []
  return Object.entries(sentiment.breakdown)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }))
}

function buildCategoryEntries(categories: CategoryBreakdown | undefined) {
  if (!categories) return []
  return Object.entries(categories.categories)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([name, value]) => ({ name, value }))
}

export function buildPDFExportData(input: PDFExportInput) {
  return {
    timeRange: input.timeRange,
    totalFeedback: input.summary?.total_feedback ?? 0,
    avgSentiment: input.summary ? Number(input.summary.avg_sentiment) : 0,
    urgentCount: input.summary?.urgent_count ?? 0,
    sourcesCount: input.sourcesCount,
    dailyTotals: input.summary?.daily_totals ?? [],
    sentimentBreakdown: buildSentimentEntries(input.sentiment),
    categoryBreakdown: buildCategoryEntries(input.categories),
    sourceBreakdown: prepareSourceData(input.sources),
    urgentItems: input.urgentFeedback?.items ?? [],
  }
}
