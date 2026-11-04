/**
 * @fileoverview The feedback boards as their own evidence source, over the app session:
 * `GET /feature-requests/insights` (a board's or every board's figures) and the admin's
 * `POST /feature-requests/insights/enrich`. Answers are normalized by
 * `./featureRequestInsightsSchema`; none of it is ever mixed into review metrics.
 *
 * (`GET /feature-requests/search` has no SPA caller: the assistant and MCP tool call it.)
 *
 * @module api/featureRequestInsights
 */
import { fetchApi } from './client'
import { post } from './requestKit'
import { normalizeEnrichResult, normalizeInsights } from './featureRequestInsightsSchema'
import type { EnrichResult, FeatureRequestInsights } from './featureRequestInsightsSchema'

/** The Insights windows offered, in days; 0 = all time. */
export const INSIGHT_WINDOWS = [30, 90, 365, 0] as const
export type InsightWindow = typeof INSIGHT_WINDOWS[number]

export function isInsightWindow(value: number): value is InsightWindow {
  return INSIGHT_WINDOWS.some((days) => days === value)
}

export interface InsightsQuery {
  /** A board's id or slug; undefined = every board the caller may see. */
  readonly board?: string
  readonly days: InsightWindow
}

/** Under the app session's board cache (`featureRequestKeys.root('app')`), so every board write refreshes them too. */
export const featureRequestInsightKeys = {
  insights: (query: InsightsQuery) => ['feature-requests', 'app', 'insights', query.board ?? '', query.days] as const,
}

function insightsParams({ board, days }: InsightsQuery): string {
  const params = new URLSearchParams({ days: String(days) })
  if (board !== undefined && board !== '') params.set('board', board)
  return params.toString()
}

export async function getFeatureRequestInsights(query: InsightsQuery): Promise<FeatureRequestInsights> {
  return normalizeInsights(await fetchApi<unknown>(`/feature-requests/insights?${insightsParams(query)}`))
}

/** Admin: queue a page of not-yet-enriched requests (`board` omitted = every board). */
export async function enrichFeatureRequests(board?: string): Promise<EnrichResult> {
  const body = board === undefined || board === '' ? {} : { board }
  return normalizeEnrichResult(await fetchApi<unknown>('/feature-requests/insights/enrich', post(body)))
}
