/**
 * @fileoverview Dimensions and tags routes.
 *
 * - `GET /settings/dimensions` (any signed-in user) / `PUT` (admin).
 * - `GET /metrics/dimensions?key=…` — counts and sentiment split per value.
 * - `PUT /feedback/{id}/dimensions` — correct one review's dimensions / tags
 *   (`null` removes a key); 400 unknown key/value, 404 not visible, 409 changed
 *   concurrently.
 *
 * Every response is normalized by `./dimensionsSchema`.
 *
 * @module api/dimensionsApi
 */
import { messageKeyForStatus, type StatusMessage } from './apiErrorStatus'
import { fetchApi } from './client'
import { buildSearchParams } from './requestKit'
import {
  normalizeDimensionMetrics, normalizeDimensionsConfig, normalizeDimensionsEdit,
} from './dimensionsSchema'
import { CATEGORY_CHANGE_KEYS } from './feedbackCategoryApi'
import type { DateRangeParams } from './client'
import type { Dimension, DimensionMetrics, DimensionsConfig, FeedbackDimensionsResult } from './dimensionsSchema'
import type { AttributeFilters } from './types'
import type { QueryClient } from '@tanstack/react-query'

/** Query key of the dimensions config (every consumer shares it). */
export const dimensionsConfigKey = () => ['dimensions-config'] as const
/** Root query key of every `/metrics/dimensions` read. */
export const dimensionMetricsKey = (params?: DimensionMetricsParams) =>
  params === undefined ? (['dimension-metrics'] as const) : (['dimension-metrics', params] as const)

export interface DimensionMetricsParams extends DateRangeParams, AttributeFilters {
  key: string
  source?: string
}

/** The body of `PUT /feedback/{id}/dimensions`: `null` removes a key; an omitted field is unchanged. */
export interface FeedbackDimensionsChange {
  dimensions?: Record<string, string | null>
  tags?: string[]
}

export const dimensionsApi = {
  getConfig: async (): Promise<DimensionsConfig> =>
    normalizeDimensionsConfig(await fetchApi<unknown>('/settings/dimensions')),

  saveConfig: async (dimensions: Dimension[]): Promise<DimensionsConfig> =>
    normalizeDimensionsConfig(await fetchApi<unknown>('/settings/dimensions', {
      method: 'PUT',
      body: JSON.stringify({ dimensions }),
    })),

  getMetrics: async (params: DimensionMetricsParams): Promise<DimensionMetrics> =>
    normalizeDimensionMetrics(await fetchApi<unknown>(`/metrics/dimensions?${buildSearchParams(params)}`)),

  setFeedbackDimensions: async (feedbackId: string, change: FeedbackDimensionsChange): Promise<FeedbackDimensionsResult> =>
    normalizeDimensionsEdit(await fetchApi<unknown>(`/feedback/${encodeURIComponent(feedbackId)}/dimensions`, {
      method: 'PUT',
      body: JSON.stringify(change),
    })),
}

/** A dimension edit moves the same caches a category edit does, plus the dimension metrics. */
export async function invalidateAfterDimensionsChange(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    [...CATEGORY_CHANGE_KEYS, dimensionMetricsKey()].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  )
}

const EDIT_ERRORS: readonly StatusMessage[] = [
  { status: 400, messageKey: 'components:dimensionsEdit.errors.invalid' },
  { status: 404, messageKey: 'components:dimensionsEdit.errors.notFound' },
  { status: 409, messageKey: 'components:dimensionsEdit.errors.conflict' },
]
const GENERIC_EDIT_ERROR = { messageKey: 'components:dimensionsEdit.errors.generic' }

/** Namespaced translation key for a failed dimensions edit. */
export function dimensionsEditErrorKey(error: unknown): string {
  return messageKeyForStatus(error, EDIT_ERRORS, GENERIC_EDIT_ERROR)
}
