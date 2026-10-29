/**
 * @fileoverview Lenient wire schemas for the Radar API (lambda/api/radar_handler.py,
 * docs/radar.md). Every field has a default, so one malformed row costs itself.
 *
 * @module api/radarSchema
 */
import { z } from 'zod'
import { lenientText, optionalText, parsedList } from './schemaList'
import { brandLanguage, brandTerms, effectiveLanguage, feedUrls, foundVia, newsKind } from './radarNewsFields'
import type { RadarLanguage } from './radarNewsFields'

const count = z.number().int().nonnegative().catch(0)
const share = z.number().min(0).max(1).nullable().catch(null)
const score = z.number().nullable().catch(null)
const texts = z.array(z.string()).catch([]).transform((values) => values.filter((value) => value !== ''))

const SENTIMENT_DEFAULT = { positive: 0, negative: 0, neutral: 0, mixed: 0 }

/**
 * `sources`: the source profile ids naming the brand (an older API omits it: none). `language`:
 * the one set (null = auto); `effective_language`: what the scan searches in; `feed_urls`: its news feeds;
 * `search_terms` / `exclude_terms`: words added to its news searches / that drop a result (none on an older API).
 */
const BRAND_FIELDS = {
  key: z.string().min(1), label: lenientText, domains: texts, sources: texts,
  language: brandLanguage, effective_language: effectiveLanguage, feed_urls: feedUrls,
  search_terms: brandTerms, exclude_terms: brandTerms,
}
/** Where a brand comes from: the brand list, or only a legacy source profile naming it. */
const ORIGIN = z.enum(['list', 'profile']).catch('list')
/** A brand without a label reads under its key. */
const labelled = <T extends { key: string; label: string }>(brand: T): T => ({ ...brand, label: brand.label === '' ? brand.key : brand.label })

const BrandSchema = z.object(BRAND_FIELDS).transform(labelled)
/** A brand named by a row of another view: its key and its label (the key when it has none). */
const BrandRefSchema = z.object({ key: z.string().min(1), label: lenientText }).transform(labelled)

const TotalsShape = {
  total: count,
  avg_sentiment: score,
  sentiment: z.object({ positive: count, negative: count, neutral: count, mixed: count }).catch(SENTIMENT_DEFAULT),
}

const BrandSummarySchema = z.object({ ...BRAND_FIELDS, ...TotalsShape }).transform(labelled)

export const CADENCES = ['daily', 'weekly', 'monthly'] as const
export type RadarCadence = typeof CADENCES[number]
const DEFAULT_RADAR_SETTINGS = { cadence: 'weekly', max_brands: 10, query_cap: 30, exa_configured: false } as const
export const MAX_BRANDS_LIMIT = 25
export const QUERY_CAP_LIMIT = 100

const SettingsSchema = z.object({
  cadence: z.enum(CADENCES).catch('weekly'),
  max_brands: z.number().int().min(1).max(MAX_BRANDS_LIMIT).catch(DEFAULT_RADAR_SETTINGS.max_brands),
  query_cap: z.number().int().min(1).max(QUERY_CAP_LIMIT).catch(DEFAULT_RADAR_SETTINGS.query_cap),
  /** Whether an Exa API key is stored (the key itself is never sent back). */
  exa_configured: z.boolean().catch(false),
}).catch({ ...DEFAULT_RADAR_SETTINGS })

const ScanSchema = z.object({
  status: z.enum(['completed', 'failed', 'skipped']).catch('failed'),
  reason: optionalText,
  started_at: optionalText,
  finished_at: optionalText,
  brands: count,
  queries: count,
  added: count,
  merged: count,
}).nullable().catch(null)

const OverviewSchema = z.object({
  brands: parsedList(BrandSummarySchema),
  last_scan: ScanSchema,
  settings: SettingsSchema,
}).catch({ brands: [], last_scan: null, settings: { ...DEFAULT_RADAR_SETTINGS } })

const ThemeSchema = z.object({
  category: z.string().min(1),
  subcategory: z.string().nullable().catch(null),
  count,
  quotes: texts,
})

const TrendPointSchema = z.object({ date: z.string().min(1), count, avg_sentiment: score })

const DetailSchema = z.object({
  brand: BrandSchema,
  ...TotalsShape,
  trend: parsedList(TrendPointSchema),
  love: parsedList(ThemeSchema),
  hate: parsedList(ThemeSchema),
  sampled: z.boolean().catch(false),
})

const ReleaseSchema = z.object({
  release_id: z.string().min(1),
  feature: z.string().min(1),
  release_date: lenientText,
  date_approximate: z.boolean().catch(false),
  summary: lenientText,
  urls: texts,
  titles: z.array(z.string()).catch([]),
  source_kind: z.enum(['official', 'third_party']).catch('third_party'),
  mentions: count,
  kind: newsKind,
  found_via: foundVia,
})

const ReleasesSchema = z.object({ releases: parsedList(ReleaseSchema) }).catch({ releases: [] })

const SideSchema = z.object({ volume: count, positive_share: share, negative_share: share })

const CompareRowSchema = z.object({
  category: z.string().min(1),
  theirs: SideSchema,
  ours: SideSchema.nullable().catch(null),
  verdict: z.enum(['they_are_better', 'we_are_better', 'even']).nullable().catch(null),
})

const CompareSchema = z.object({
  categories: parsedList(CompareRowSchema),
  ours_available: z.boolean().catch(false),
}).catch({ categories: [], ours_available: false })

export const RADAR_SENTIMENTS = ['positive', 'negative', 'neutral', 'mixed'] as const
export type RadarSentiment = typeof RADAR_SENTIMENTS[number]

/** One review behind a theme, a day or a category (GET /radar/brands/{brand}/reviews). */
const ReviewSchema = z.object({
  feedback_id: z.string().min(1),
  day: lenientText,
  title: optionalText,
  text: lenientText,
  quote: optionalText,
  rating: z.number().optional().catch(undefined),
  sentiment_label: z.enum(RADAR_SENTIMENTS).catch('neutral'),
  sentiment_score: score,
  category: z.string().min(1).catch('other'),
  subcategory: z.string().min(1).nullable().catch(null),
  urgency: optionalText,
  problem_summary: optionalText,
  source_platform: lenientText,
  // Only a web link is ever rendered as one.
  source_url: z.string().regex(/^https?:\/\//u).optional().catch(undefined),
})

const ReviewsPageSchema = z.object({
  reviews: parsedList(ReviewSchema),
  next_cursor: z.string().min(1).nullable().catch(null),
}).catch({ reviews: [], next_cursor: null })

/** At most this many brands in the list, and domains per brand (shared/radar_brands.py). */
export const MAX_RADAR_BRANDS = 25
export const MAX_RADAR_DOMAINS = 10

/**
 * One brand of GET /radar/brands: `origin` says where it comes from, the brand list
 * (`list`) or only a legacy source profile naming it (`profile`, kept until the next save).
 */
const BrandEntrySchema = z.object({ ...BRAND_FIELDS, origin: ORIGIN }).transform(labelled)

const BrandsSchema = z.object({ brands: parsedList(BrandEntrySchema) }).catch({ brands: [] })

/** GET /radar/brands/{brand}/reviews/{id}: one review with the enrichment the list leaves out. */
const ReviewDetailSchema = z.object({
  brand: BrandRefSchema,
  review: ReviewSchema.extend({
    persona_name: optionalText,
    persona_type: optionalText,
    journey_stage: optionalText,
    impact_area: optionalText,
    problem_root_cause_hypothesis: optionalText,
    source_created_at: optionalText,
    source_channel: optionalText,
    language: optionalText,
  }),
})


/**
 * One brand of GET /radar/all: the brand, its totals in the window, how many releases fell in it
 * and its newest release (null when it has none, or a malformed one).
 */
const AllBrandSchema = z.object({
  ...BRAND_FIELDS,
  origin: ORIGIN,
  ...TotalsShape,
  releases_in_window: count,
  latest_release: ReleaseSchema.nullable().catch(null),
}).transform(labelled)

/** A release of the combined feed: the brand page's release, plus the brand it is about. */
const BrandReleaseSchema = ReleaseSchema.extend({ brand: BrandRefSchema })

/** GET /radar/all?days=: every tracked brand side by side, and their releases newest first (≤ 100). */
const AllBrandsSchema = z.object({
  days: count,
  brands: parsedList(AllBrandSchema),
  releases: parsedList(BrandReleaseSchema),
  releases_total: count,
  releases_capped: z.boolean().catch(false),
}).catch({ days: 0, brands: [], releases: [], releases_total: 0, releases_capped: false })

export type RadarOverview = z.infer<typeof OverviewSchema>
export type RadarBrandSummary = z.infer<typeof BrandSummarySchema>
export type RadarScan = NonNullable<z.infer<typeof ScanSchema>>
export type RadarSettings = z.infer<typeof SettingsSchema>
export type RadarDetail = z.infer<typeof DetailSchema>
export type RadarTheme = z.infer<typeof ThemeSchema>
export type RadarRelease = z.infer<typeof ReleaseSchema>
export type RadarCompareRow = z.infer<typeof CompareRowSchema>
export type RadarCompare = z.infer<typeof CompareSchema>
export type RadarReview = z.infer<typeof ReviewSchema>
export type RadarReviewsPage = z.infer<typeof ReviewsPageSchema>
export type RadarBrandEntry = z.infer<typeof BrandEntrySchema>
export type RadarReviewDetail = z.infer<typeof ReviewDetailSchema>
export type RadarBrandRef = z.infer<typeof BrandRefSchema>
export type RadarAllBrand = z.infer<typeof AllBrandSchema>
export type RadarAllBrands = z.infer<typeof AllBrandsSchema>
/** One brand of what PUT /radar/brands takes (the whole list); an absent language, feed or term list = auto / none. */
export interface RadarBrandInput {
  readonly label: string
  readonly domains: readonly string[]
  readonly language?: RadarLanguage | null
  readonly feed_urls?: readonly string[]
  readonly search_terms?: readonly string[]
  readonly exclude_terms?: readonly string[]
}
/** What PUT /radar/settings takes: the scan settings (the Exa key has its own route). */
export type RadarScanSettings = Omit<RadarSettings, 'exa_configured'>

export const normalizeRadarOverview = (raw: unknown): RadarOverview => OverviewSchema.parse(raw)
/** The detail view, or null when the answer carries no usable brand. */
function normalizeRadarDetail(raw: unknown): RadarDetail | null {
  const parsed = DetailSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
const normalizeRadarReleases = (raw: unknown): RadarRelease[] => ReleasesSchema.parse(raw).releases
const normalizeRadarCompare = (raw: unknown): RadarCompare => CompareSchema.parse(raw)

/** GET /radar/brands/{brand}/page: the Radar page's one read for a brand. */
export interface RadarBrandPage {
  /** Null when the answer carries no usable brand (the page shows its load error). */
  readonly detail: RadarDetail | null
  readonly releases: RadarRelease[]
  readonly compare: RadarCompare
}

// Each part is normalized on its own (one bad part never blanks the others); an absent one reads as empty.
const PageSchema = z.object({ detail: z.unknown().optional(), releases: z.unknown().optional(), compare: z.unknown().optional() })
  .catch({})

export function normalizeRadarPage(raw: unknown): RadarBrandPage {
  const page = PageSchema.parse(raw)
  return {
    detail: normalizeRadarDetail(page.detail),
    releases: normalizeRadarReleases(page.releases),
    compare: normalizeRadarCompare(page.compare),
  }
}
export const normalizeRadarSettings = (raw: unknown): RadarSettings =>
  SettingsSchema.parse(z.object({ settings: z.unknown() }).catch({ settings: undefined }).parse(raw).settings)
/** PUT / DELETE /radar/settings/exa-key: whether a key is stored now (false on anything unusable). */
export const normalizeExaKeyAnswer = (raw: unknown): boolean =>
  z.object({ exa_configured: z.boolean() }).catch({ exa_configured: false }).parse(raw).exa_configured
export const normalizeRadarAll = (raw: unknown): RadarAllBrands => AllBrandsSchema.parse(raw)
export const normalizeRadarReviews = (raw: unknown): RadarReviewsPage => ReviewsPageSchema.parse(raw)
export const normalizeRadarBrands = (raw: unknown): RadarBrandEntry[] => BrandsSchema.parse(raw).brands
/** The review, or null when the answer carries none. */
export function normalizeRadarReviewDetail(raw: unknown): RadarReviewDetail | null {
  const parsed = ReviewDetailSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
