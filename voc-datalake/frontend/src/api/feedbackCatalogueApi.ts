/**
 * @fileoverview `GET /feedback/catalogue` — what every stored field of a feedback item means
 * (docs/data-catalogue.md), normalized by `./feedbackCatalogueSchema`. The catalogue changes only with a
 * deployment, so it is read once per session (a long `staleTime`).
 * @module api/feedbackCatalogueApi
 */
import { fetchApi } from './client'
import { normalizeFeedbackCatalogue } from './feedbackCatalogueSchema'
import type { FeedbackCatalogue } from './feedbackCatalogueSchema'

export const FEEDBACK_CATALOGUE_KEY = ['feedback-catalogue'] as const

/** One hour: the answer is the deployed code's catalogue, never per-user or per-day data. */
export const FEEDBACK_CATALOGUE_STALE_MS = 60 * 60 * 1000

export async function getFeedbackCatalogue(): Promise<FeedbackCatalogue> {
  return normalizeFeedbackCatalogue(await fetchApi<unknown>('/feedback/catalogue'))
}
