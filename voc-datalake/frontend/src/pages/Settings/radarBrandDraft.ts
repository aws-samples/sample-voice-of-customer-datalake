/**
 * @fileoverview The Radar brand list as edited in Administration → Sources → Radar: the draft
 * built from GET /radar/brands (list brands and legacy source-profile brands alike), the checks
 * an added brand passes before it joins the draft, and the PUT /radar/brands body. The server
 * validates again (shared/radar_brands.py); these checks only spare a round trip.
 * @module pages/Settings/radarBrandDraft
 */
import { MAX_RADAR_BRANDS, MAX_RADAR_DOMAINS } from '../../api/radarSchema'
import { MAX_RADAR_FEEDS, MAX_RADAR_TERMS, MAX_RADAR_TERM_CHARS, isFeedUrl } from '../../api/radarNewsFields'
import type { RadarBrandEntry, RadarBrandInput } from '../../api/radarSchema'
import type { RadarLanguage } from '../../api/radarNewsFields'

/** One brand of the draft: what GET /radar/brands said, with the domains as edited. */
export interface BrandDraft {
  readonly key: string
  readonly label: string
  readonly domains: readonly string[]
  readonly origin: RadarBrandEntry['origin']
  readonly sources: readonly string[]
  /** The language set (null = auto) and the one the server last derived (null for a brand not saved yet). */
  readonly language: RadarLanguage | null
  readonly effective_language: RadarLanguage | null
  readonly feed_urls: readonly string[]
  /** Words added to its news searches, and words that drop a result (shared/radar_brand_terms.py). */
  readonly search_terms: readonly string[]
  readonly exclude_terms: readonly string[]
}

/** What a new brand may carry beyond its name and domains. */
export interface BrandExtras {
  readonly language: RadarLanguage | null
  readonly feed_urls: readonly string[]
  readonly search_terms: readonly string[]
  readonly exclude_terms: readonly string[]
}

/** The two term lists of a brand. */
export type TermsField = 'search_terms' | 'exclude_terms'

/** Why a term list cannot be saved (an i18n key under `radar:brands`), or null. */
export type TermsProblem = 'termsTooMany' | 'termsTooLong' | 'termsInvalid'

/** Why a feed list cannot be saved (an i18n key under `radar:brands`), or null. */
export type FeedsProblem = 'feedsTooMany' | 'feedsHttps'

/** Why a new brand cannot join the draft (an i18n key under `radar:brands`), or null. */
export type AddProblem = 'invalidName' | 'duplicate' | 'tooMany'

// shared/radar_brands._BRAND_RE: a word character first, then word characters, spaces and . & ' + -
const BRAND_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_ .&'+-]{0,63}$/u

/** shared/radar_brands.brand_key: lower-cased, every run of non-word characters folded to one '-'. */
function brandKey(name: string): string {
  return name.trim().toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((part) => part !== '').join('-')
}

/** Inner whitespace folded to one space, as the server stores the label. */
function cleanLabel(name: string): string {
  return name.split(/\s+/u).filter((part) => part !== '').join(' ')
}

/** Comma-separated domains as typed: trimmed, blanks and repeats dropped, at most the cap. */
export function splitDomains(text: string): string[] {
  const domains = text.split(',').map((domain) => domain.trim().toLowerCase()).filter((domain) => domain !== '')
  return [...new Set(domains)].slice(0, MAX_RADAR_DOMAINS)
}

/**
 * Feeds as typed, one per line or comma separated: trimmed, blanks and repeats dropped. Never
 * capped here, so a fourth feed is reported (feedsProblem) instead of silently lost.
 */
export function splitFeeds(text: string): string[] {
  return [...new Set(text.split(/[\n,]/u).map((url) => url.trim()).filter((url) => url !== ''))]
}

/**
 * Terms as typed, one per line (a legal name may hold a comma): whitespace folded, blanks and repeats (in any
 * case) dropped. Never capped here, so a ninth term is reported (termsProblem) instead of silently lost.
 */
export function splitTerms(text: string): string[] {
  const terms = text.split('\n').map((term) => term.split(/\s+/u).filter((part) => part !== '').join(' ')).filter((term) => term !== '')
  return terms.filter((term, index) => terms.findIndex((other) => other.toLowerCase() === term.toLowerCase()) === index)
}

/** Null when the terms may be saved, else why not (the server's rules: no double quote, no leading "-"). */
export function termsProblem(terms: readonly string[]): TermsProblem | null {
  if (terms.length > MAX_RADAR_TERMS) return 'termsTooMany'
  if (terms.some((term) => term.length > MAX_RADAR_TERM_CHARS)) return 'termsTooLong'
  return terms.some((term) => term.includes('"') || term.startsWith('-')) ? 'termsInvalid' : null
}

/** Whether every list of `brand` may be saved (feeds and both term lists). */
export function brandSavable(brand: Pick<BrandDraft, 'feed_urls' | TermsField>): boolean {
  return feedsProblem(brand.feed_urls) === null && termsProblem(brand.search_terms) === null && termsProblem(brand.exclude_terms) === null
}

/** Null when the feeds may be saved, else why not. */
export function feedsProblem(feeds: readonly string[]): FeedsProblem | null {
  if (feeds.length > MAX_RADAR_FEEDS) return 'feedsTooMany'
  return feeds.every(isFeedUrl) ? null : 'feedsHttps'
}

export function toDraft(brands: readonly RadarBrandEntry[]): BrandDraft[] {
  return brands.map((brand) => ({
    key: brand.key, label: brand.label, domains: brand.domains, origin: brand.origin, sources: brand.sources,
    language: brand.language, effective_language: brand.effective_language, feed_urls: brand.feed_urls,
    search_terms: brand.search_terms, exclude_terms: brand.exclude_terms,
  }))
}

/** Null when `name` may be added to `draft`, else why not. */
export function addProblem(draft: readonly BrandDraft[], name: string): AddProblem | null {
  const label = cleanLabel(name)
  if (!BRAND_NAME.test(label) || brandKey(label) === '') return 'invalidName'
  if (draft.some((brand) => brand.key === brandKey(label))) return 'duplicate'
  return draft.length >= MAX_RADAR_BRANDS ? 'tooMany' : null
}

/** A brand added in the editor: on the list, fed by no source profile yet. */
export function newBrand(name: string, domainsText: string, extras: BrandExtras): BrandDraft {
  const label = cleanLabel(name)
  return {
    key: brandKey(label), label, domains: splitDomains(domainsText), origin: 'list', sources: [],
    language: extras.language, effective_language: null, feed_urls: extras.feed_urls,
    search_terms: extras.search_terms, exclude_terms: extras.exclude_terms,
  }
}

/**
 * The PUT body: every brand of the draft, so a legacy profile brand is saved into the list
 * with its domains (it stays tracked if the profile is later changed).
 */
export function toInput(draft: readonly BrandDraft[]): RadarBrandInput[] {
  return draft.map((brand) => ({
    label: brand.label, domains: [...brand.domains], language: brand.language, feed_urls: [...brand.feed_urls],
    search_terms: [...brand.search_terms], exclude_terms: [...brand.exclude_terms],
  }))
}

/**
 * Whether the draft differs from what was loaded (a real edit: added, removed or re-domained
 * brand, or a new language, feed list or term list). A legacy profile brand is part of the loaded state, not
 * a change: it is written into the list with the next real save.
 */
export function needsSave(draft: readonly BrandDraft[], saved: readonly BrandDraft[]): boolean {
  return JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(saved))
}
