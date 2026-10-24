/**
 * @fileoverview `GET /metrics/release-watch` (metrics Lambda, read-only, the caller's scope).
 * @module api/releaseWatchApi
 */
import { fetchApi } from './client'
import { normalizeReleaseWatch } from './releaseWatchSchema'

export interface ReleaseWatchQuery {
  /** Look back this many days for GitHub releases (server default 90, at most 365). */
  days?: number
  /** Days compared on each side (server default 14). */
  window?: number
  /** A dated launch instead of the GitHub releases (YYYY-MM-DD) and its label. */
  launchedAt?: string
  label?: string
  category?: string
  /** Keywords; every one must occur in an item. */
  q?: string
}

function searchParams(query: ReleaseWatchQuery): string {
  const pairs: [string, string | number | undefined][] = [
    ['days', query.days], ['window', query.window], ['launched_at', query.launchedAt],
    ['label', query.label], ['category', query.category], ['q', query.q],
  ]
  return new URLSearchParams(pairs.flatMap(([key, value]) => (
    value === undefined || value === '' ? [] : [[key, String(value)]]
  ))).toString()
}

export const releaseWatchApi = {
  getReleaseWatch: async (query: ReleaseWatchQuery = {}) => {
    const params = searchParams(query)
    return normalizeReleaseWatch(await fetchApi<unknown>(`/metrics/release-watch?${params}`))
  },
}
