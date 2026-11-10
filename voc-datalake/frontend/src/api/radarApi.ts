/**
 * @fileoverview Radar API client (docs/radar.md): other brands tracked by
 * Radar sources, kept apart from our own feedback. Reads for every signed-in
 * user; settings and "Scan now" are admin-only server-side.
 *
 * @module api/radarApi
 */
import { del, post, put } from './requestKit'
import { fetchApi } from './client'
import {
  normalizeExaKeyAnswer,
  normalizeRadarAll,
  normalizeRadarBrands,
  normalizeRadarOverview,
  normalizeRadarPage,
  normalizeRadarReviewDetail,
  normalizeRadarReviews,
  normalizeRadarSettings,
} from './radarSchema'
import type {
  RadarAllBrands, RadarBrandEntry, RadarBrandInput, RadarBrandPage, RadarOverview, RadarReviewDetail,
  RadarReviewsPage, RadarScanSettings, RadarSentiment, RadarSettings,
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
  page: (brand: string, days: number) => ['radar', 'page', brand, days] as const,
  all: (days: number) => ['radar', 'all', days] as const,
  reviews: (brand: string, days: number, filter: RadarReviewFilter) => ['radar', 'reviews', brand, days, filter] as const,
}

const brandPath = (brand: string) => `/radar/brands/${encodeURIComponent(brand)}`

export const radarApi = {
  getOverview: async (): Promise<RadarOverview> => normalizeRadarOverview(await fetchApi<unknown>('/radar')),

  /**
   * A brand's detail, releases (their own year) and comparison in ONE request: three requests at
   * once made a cold function start a second environment (docs/caching.md, "First load").
   */
  getPage: async (brand: string, days: number): Promise<RadarBrandPage> =>
    normalizeRadarPage(await fetchApi<unknown>(`${brandPath(brand)}/page?days=${days}`)),

  /** Every tracked brand side by side over the window, and their releases newest first (at most 100). */
  getAll: async (days: number): Promise<RadarAllBrands> => normalizeRadarAll(await fetchApi<unknown>(`/radar/all?days=${days}`)),

  getReviews: async (brand: string, days: number, filter: RadarReviewFilter, cursor?: string): Promise<RadarReviewsPage> =>
    normalizeRadarReviews(await fetchApi<unknown>(`${brandPath(brand)}/reviews?${reviewsQuery(days, filter, cursor)}`)),

  /** The effective brands (the list, then legacy source-profile brands), each with its origin. */
  getBrands: async (): Promise<RadarBrandEntry[]> => normalizeRadarBrands(await fetchApi<unknown>('/radar/brands')),

  /** Replace the whole brand list (admin). Removing a brand keeps its stored reviews and releases. */
  saveBrands: async (brands: readonly RadarBrandInput[]): Promise<RadarBrandEntry[]> =>
    normalizeRadarBrands(await fetchApi<unknown>('/radar/brands', put({ brands }))),

  /** One Radar review with its enrichment, or null when the answer carries none (404 throws). */
  getReview: async (brand: string, feedbackId: string): Promise<RadarReviewDetail | null> =>
    normalizeRadarReviewDetail(await fetchApi<unknown>(`${brandPath(brand)}/reviews/${encodeURIComponent(feedbackId)}`)),

  /** The scan settings only: `exa_configured` is read-only (the key has its own route). */
  saveSettings: async (settings: RadarScanSettings): Promise<RadarSettings> => normalizeRadarSettings(await fetchApi<unknown>(
    '/radar/settings', put({ cadence: settings.cadence, max_brands: settings.max_brands, query_cap: settings.query_cap }),
  )),

  /** Store the Exa API key (admin); the answer says only whether one is stored, never the key. */
  saveExaKey: async (apiKey: string): Promise<boolean> =>
    normalizeExaKeyAnswer(await fetchApi<unknown>('/radar/settings/exa-key', put({ api_key: apiKey }))),

  /** Remove the stored Exa key (admin): Radar stops searching Exa. */
  removeExaKey: async (): Promise<boolean> =>
    normalizeExaKeyAnswer(await fetchApi<unknown>('/radar/settings/exa-key', del())),

  startScan: (brand?: string) => fetchApi<unknown>('/radar/scan', post(brand === undefined ? {} : { brand })),
}
