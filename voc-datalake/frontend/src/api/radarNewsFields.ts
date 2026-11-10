/**
 * @fileoverview Lenient wire fields of Radar's news (docs/radar.md → "News and releases"): a
 * brand's search language, news feeds and search / exclude terms, what kind of news an item is and how the scan found
 * it. Each field falls back to what an older API meant, so an old row reads as before (a
 * `release` found by web search, a brand in its domain's language with no feed).
 *
 * @module api/radarNewsFields
 */
import { z } from 'zod'
import { isHttpsUrl } from '../utils/httpsUrl'

/** The languages a brand's news may be searched in (shared/radar_brands.py `LANGUAGES`). */
export const RADAR_LANGUAGES = ['en', 'pl', 'cs', 'sk', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'fi', 'no', 'hu', 'ro'] as const
export type RadarLanguage = typeof RADAR_LANGUAGES[number]

/** What a news item is about; an older row is a `release`. */
export const RADAR_NEWS_KINDS = ['release', 'announcement', 'promotion', 'partnership', 'news'] as const
export type RadarNewsKind = typeof RADAR_NEWS_KINDS[number]

/** How the scan found an item: our web search, the Exa index, or the brand's own feed. */
const FOUND_VIA = ['web', 'exa', 'feed'] as const
export type RadarFoundVia = typeof FOUND_VIA[number]

/** At most this many news feeds per brand, each an https link. */
export const MAX_RADAR_FEEDS = 3

/** At most this many search terms and exclude terms per brand, each this long (shared/radar_brand_terms.py). */
export const MAX_RADAR_TERMS = 8
export const MAX_RADAR_TERM_CHARS = 60

/** A type guard for membership of one of the closed lists above. */
function oneOf<T extends string>(values: readonly T[]): (value: unknown) => value is T {
  return (value: unknown): value is T => values.some((entry) => entry === value)
}

export const isRadarLanguage = oneOf(RADAR_LANGUAGES)
const isNewsKind = oneOf(RADAR_NEWS_KINDS)
const isFoundVia = oneOf(FOUND_VIA)

/** A feed link: a string that is an https URL with a host (`utils/httpsUrl`). */
export function isFeedUrl(value: unknown): value is string {
  return typeof value === 'string' && isHttpsUrl(value)
}

/**
 * A field read from whatever came (absent included: an older API) through `read`. The
 * `.optional()` lets zod 4 pass an absent key to `read` instead of failing the whole row.
 */
const fromAnything = <T>(read: (value: unknown) => T) => z.unknown().optional().transform(read)

/** The language set on the brand; null = auto (anything off the allowlist reads as auto). */
export const brandLanguage = fromAnything((value): RadarLanguage | null => (isRadarLanguage(value) ? value : null))

/** The language the scan searches in: the set one, else the domain's, else English. */
export const effectiveLanguage = fromAnything((value): RadarLanguage => (isRadarLanguage(value) ? value : 'en'))

/** The brand's news feeds: https links only, at most the cap. */
export const feedUrls = fromAnything((value): string[] =>
  (Array.isArray(value) ? value.filter(isFeedUrl).slice(0, MAX_RADAR_FEEDS) : []))

/** A brand's search terms or exclude terms: non-empty strings only, at most the cap (an older API: none). */
export const brandTerms = fromAnything((value): string[] =>
  (Array.isArray(value) ? value.filter((term): term is string => typeof term === 'string' && term !== '').slice(0, MAX_RADAR_TERMS) : []))

/** A missing kind is an older row (a release); a kind this client does not know reads as company news. */
export const newsKind = fromAnything((value): RadarNewsKind => {
  if (value === undefined || value === null) return 'release'
  return isNewsKind(value) ? value : 'news'
})

/** Known sources only, each once; none (or an older row) = our web search. */
export const foundVia = fromAnything((value): RadarFoundVia[] => {
  const known = Array.isArray(value) ? [...new Set(value.filter(isFoundVia))] : []
  return known.length === 0 ? ['web'] : known
})
