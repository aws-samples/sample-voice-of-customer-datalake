/**
 * @fileoverview Radar API client (docs/radar.md): other brands tracked by
 * Radar sources, kept apart from our own feedback. Reads for every signed-in
 * user; settings and "Scan now" are admin-only server-side.
 *
 * @module api/radarApi
 */
import { fetchApi } from './client'
import {
  normalizeRadarBrands,
  normalizeRadarCompare,
  normalizeRadarDetail,
  normalizeRadarOverview,
  normalizeRadarReleases,
  normalizeRadarReviewDetail,
  normalizeRadarReviews,
  normalizeRadarSettings,
} from './radarSchema'
import type {
  RadarBrandEntry, RadarBrandInput, RadarCompare, RadarDetail, RadarOverview, RadarRelease, RadarReviewDetail,
  RadarReviewsPage, RadarSentiment, RadarSettings,
} from './radarSchema'

/**
 * What the reviews list is narrowed to. `subcategory: ''` asks for the reviews WITHOUT a
 * subcategory (a theme like `pricing` alone); leaving it out means any subcategory.
 */
export interface RadarReviewFilter {
  readonly category?: string
  readonly subcategory?: string
  readonly sentiment?: RadarSentiment
  readonly day?: string
}

/** The query string of one reviews page: the window, the filter, and the cursor when paging on. */
function reviewsQuery(days: number, filter: RadarReviewFilter, cursor?: string): string {
  const entries: Array<[string, string | undefined]> = [
    ['days', String(days)], ['category', filter.category], ['subcategory', filter.subcategory],
    ['sentiment', filter.sentiment], ['day', filter.day], ['cursor', cursor],
  ]
  return new URLSearchParams(entries.flatMap(([key, value]) => (value === undefined ? [] : [[key, value]]))).toString()
}

export const radarKeys = {
  overview: () => ['radar', 'overview'] as const,
  brands: () => ['radar', 'brands'] as const,
  review: (brand: string, feedbackId: string) => ['radar', 'review', brand, feedbackId] as const,
  detail: (brand: string, days: number) => ['radar', 'detail', brand, days] as const,
  releases: (brand: string) => ['radar', 'releases', brand] as const,
  compare: (brand: string, days: number) => ['radar', 'compare', brand, days] as const,
  reviews: (brand: string, days: number, filter: RadarReviewFilter) => ['radar', 'reviews', brand, days, filter] as const,
}

const brandPath = (brand: string) => `/radar/brands/${encodeURIComponent(brand)}`

export const radarApi = {
  getOverview: async (): Promise<RadarOverview> => normalizeRadarOverview(await fetchApi<unknown>('/radar')),

  getDetail: async (brand: string, days: number): Promise<RadarDetail | null> =>
    normalizeRadarDetail(await fetchApi<unknown>(`${brandPath(brand)}?days=${days}`)),

  getReleases: async (brand: string): Promise<RadarRelease[]> =>
    normalizeRadarReleases(await fetchApi<unknown>(`${brandPath(brand)}/releases`)),

  getCompare: async (brand: string, days: number): Promise<RadarCompare> =>
    normalizeRadarCompare(await fetchApi<unknown>(`${brandPath(brand)}/compare?days=${days}`)),

  getReviews: async (brand: string, days: number, filter: RadarReviewFilter, cursor?: string): Promise<RadarReviewsPage> =>
    normalizeRadarReviews(await fetchApi<unknown>(`${brandPath(brand)}/reviews?${reviewsQuery(days, filter, cursor)}`)),

  /** The effective brands (the list, then legacy source-profile brands), each with its origin. */
  getBrands: async (): Promise<RadarBrandEntry[]> => normalizeRadarBrands(await fetchApi<unknown>('/radar/brands')),

  /** Replace the whole brand list (admin). Removing a brand keeps its stored reviews and releases. */
  saveBrands: async (brands: readonly RadarBrandInput[]): Promise<RadarBrandEntry[]> =>
    normalizeRadarBrands(await fetchApi<unknown>('/radar/brands', { method: 'PUT', body: JSON.stringify({ brands }) })),

  /** One Radar review with its enrichment, or null when the answer carries none (404 throws). */
  getReview: async (brand: string, feedbackId: string): Promise<RadarReviewDetail | null> =>
    normalizeRadarReviewDetail(await fetchApi<unknown>(`${brandPath(brand)}/reviews/${encodeURIComponent(feedbackId)}`)),

  saveSettings: async (settings: RadarSettings): Promise<RadarSettings> =>
    normalizeRadarSettings(await fetchApi<unknown>('/radar/settings', { method: 'PUT', body: JSON.stringify(settings) })),

  startScan: (brand?: string) => fetchApi<unknown>('/radar/scan', {
    method: 'POST',
    body: JSON.stringify(brand === undefined ? {} : { brand }),
  }),
}
