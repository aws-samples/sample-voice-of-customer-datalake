/**
 * @fileoverview Pure shaping of the dashboard's API data for its charts and PDF export.
 * @module pages/Dashboard/dashboardData
 */
import type { TFunction } from 'i18next'
import type { MetricsSummary, SentimentBreakdown, CategoryBreakdown, SourceBreakdown, FeedbackItem } from '../../api/types'
import { topCategoryEntries } from '../../utils/categoryOrder'

/**
 * The lower-bound hint for partial counts. A walk stopped by its time budget
 * names the oldest day it reached; every other cause gets the generic hint.
 */
export function partialHintText(isPartial: boolean, scannedThrough: string | null, t: TFunction): string | undefined {
  if (!isPartial) return undefined
  if (scannedThrough === null) return t('common:partialCountsHint')
  return t('common:partialTimeBudgetHint', { date: scannedThrough })
}

export function prepareSourceData(sources: SourceBreakdown | undefined, label: (id: string) => string) {
  if (!sources) return []
  return Object.entries(sources.sources)
    .map(([id, value]) => ({ id, name: label(id), value }))
}

/** A chart bar: its label, its count, and the id it filters Categories by (null for a rolled-up "Other"). */
export interface ChartRow {
  readonly id: string | null
  readonly name: string
  readonly value: number
}

/** Bars the "Feedback by Source" chart draws before rolling the rest into one "Other" bar. */
const SOURCE_BARS = 8

/**
 * The source chart's bars: largest first, the top eight by name and the rest
 * summed into one bar labelled by `otherLabel(count of sources folded in)` —
 * the usual top-N + "Other" so a long tail (range All) stays readable.
 */
export function sourceChartRows(
  sources: SourceBreakdown | undefined,
  label: (id: string) => string,
  otherLabel: (n: number) => string,
): ChartRow[] {
  const ranked = prepareSourceData(sources, label).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
  if (ranked.length <= SOURCE_BARS + 1) return ranked
  const rest = ranked.slice(SOURCE_BARS)
  const otherTotal = rest.reduce((sum, row) => sum + row.value, 0)
  return [...ranked.slice(0, SOURCE_BARS), { id: null, name: otherLabel(rest.length), value: otherTotal }]
}

/** Sources that brought at least one review in the window: the "Sources with reviews" tile. */
export function activeSourceCount(sources: SourceBreakdown | undefined): number {
  return Object.values(sources?.sources ?? {}).filter((count) => count > 0).length
}

/** One day of the trend: review count, and the day's average sentiment (null on a day without reviews). */
export interface TrendPoint {
  readonly date: string
  readonly reviews: number
  readonly sentiment: number | null
}

/** Longest gap the trend zero-fills; a wider span (all time) is drawn from the days it has. */
const MAX_FILLED_DAYS = 400
const DAY_MS = 24 * 60 * 60 * 1000

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Every calendar day from `first` to `last` (YYYY-MM-DD, UTC), or undefined past {@link MAX_FILLED_DAYS}. */
function daysBetween(first: string, last: string): string[] | undefined {
  const start = Date.parse(`${first}T00:00:00Z`)
  const end = Date.parse(`${last}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  const span = Math.round((end - start) / DAY_MS) + 1
  if (span > MAX_FILLED_DAYS) return undefined
  return Array.from({ length: span }, (_, i) => isoDay(start + i * DAY_MS))
}

/**
 * The trend's days, oldest first: volume from `daily_totals`, the average from
 * `daily_sentiment`, and every missing day in between filled with 0 reviews (and
 * no average), so a day without data reads as "0", never as a line bridging it.
 */
export function trendSeries(summary: Pick<MetricsSummary, 'daily_totals' | 'daily_sentiment'> | undefined): TrendPoint[] {
  const totals = new Map((summary?.daily_totals ?? []).map((d) => [d.date, d.count]))
  const sentiment = new Map((summary?.daily_sentiment ?? []).map((d) => [d.date, d.avg_sentiment]))
  const known = [...new Set([...totals.keys(), ...sentiment.keys()])].sort((a, b) => a.localeCompare(b))
  const first = known.at(0)
  const last = known.at(-1)
  if (first === undefined || last === undefined) return []
  const days = daysBetween(first, last) ?? known
  return days.map((date) => ({ date, reviews: totals.get(date) ?? 0, sentiment: sentiment.get(date) ?? null }))
}

/** The label lookups the export needs (from `useDisplayLabels`; the PDF renders outside React's providers). */
type ExportLabels = Readonly<{ category: (id: string) => string; source: (id: string) => string }>

interface PDFExportInput {
  summary: MetricsSummary | undefined
  sentiment: SentimentBreakdown | undefined
  categories: CategoryBreakdown | undefined
  sources: SourceBreakdown | undefined
  urgentFeedback: { items?: FeedbackItem[]; count?: number } | undefined
  timeRange: string
  sourcesCount: number
  labels: ExportLabels
}

function buildSentimentEntries(sentiment: SentimentBreakdown | undefined) {
  if (!sentiment) return []
  return Object.entries(sentiment.breakdown)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }))
}

function buildCategoryEntries(categories: CategoryBreakdown | undefined, label: (id: string) => string) {
  if (!categories) return []
  return topCategoryEntries(Object.entries(categories.categories), 10)
    .map(([name, value]) => ({ name: label(name), value }))
}

/** The urgent items as the PDF prints them: source and category already labelled (a display copy; ids are not sent anywhere). */
function labelUrgentItems(items: readonly FeedbackItem[], labels: ExportLabels): FeedbackItem[] {
  return items.map((item) => ({ ...item, source_platform: labels.source(item.source_platform), category: labels.category(item.category) }))
}

export function buildPDFExportData(input: PDFExportInput) {
  return {
    timeRange: input.timeRange,
    totalFeedback: input.summary?.total_feedback ?? 0,
    avgSentiment: input.summary ? input.summary.avg_sentiment : 0,
    urgentCount: input.summary?.urgent_count ?? 0,
    sourcesCount: input.sourcesCount,
    dailyTotals: input.summary?.daily_totals ?? [],
    sentimentBreakdown: buildSentimentEntries(input.sentiment),
    categoryBreakdown: buildCategoryEntries(input.categories, input.labels.category),
    sourceBreakdown: prepareSourceData(input.sources, input.labels.source),
    urgentItems: labelUrgentItems(input.urgentFeedback?.items ?? [], input.labels),
  }
}
