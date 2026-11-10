/**
 * @fileoverview `GET /metrics/data-quality?days=` — the per-source usefulness distribution
 * (docs/data-quality.md), normalized by `./dataQualitySchema`.
 * @module api/dataQualityApi
 */
import { fetchApi } from './client'
import { normalizeDataQuality } from './dataQualitySchema'
import { buildSearchParams } from './requestKit'
import type { DateRangeParams } from './client'
import type { DataQuality } from './dataQualitySchema'

/** Query key of one `/metrics/data-quality` read. */
export const dataQualityKey = (range: DateRangeParams) => ['data-quality', range] as const

export async function getDataQuality(range: DateRangeParams): Promise<DataQuality> {
  return normalizeDataQuality(await fetchApi<unknown>(`/metrics/data-quality?${buildSearchParams(range)}`))
}
