/**
 * @fileoverview The Radar brand list as edited in Administration → Sources → Radar: the draft
 * built from GET /radar/brands (list brands and legacy source-profile brands alike), the checks
 * an added brand passes before it joins the draft, and the PUT /radar/brands body. The server
 * validates again (shared/radar_brands.py); these checks only spare a round trip.
 * @module pages/Settings/radarBrandDraft
 */
import { MAX_RADAR_BRANDS, MAX_RADAR_DOMAINS } from '../../api/radarSchema'
import type { RadarBrandEntry, RadarBrandInput } from '../../api/radarSchema'

/** One brand of the draft: what GET /radar/brands said, with the domains as edited. */
export interface BrandDraft {
  readonly key: string
  readonly label: string
  readonly domains: readonly string[]
  readonly origin: RadarBrandEntry['origin']
  readonly sources: readonly string[]
}

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

export function toDraft(brands: readonly RadarBrandEntry[]): BrandDraft[] {
  return brands.map(({ key, label, domains, origin, sources }) => ({ key, label, domains, origin, sources }))
}

/** Null when `name` may be added to `draft`, else why not. */
export function addProblem(draft: readonly BrandDraft[], name: string): AddProblem | null {
  const label = cleanLabel(name)
  if (!BRAND_NAME.test(label) || brandKey(label) === '') return 'invalidName'
  if (draft.some((brand) => brand.key === brandKey(label))) return 'duplicate'
  return draft.length >= MAX_RADAR_BRANDS ? 'tooMany' : null
}

/** A brand added in the editor: on the list, fed by no source profile yet. */
export function newBrand(name: string, domainsText: string): BrandDraft {
  const label = cleanLabel(name)
  return { key: brandKey(label), label, domains: splitDomains(domainsText), origin: 'list', sources: [] }
}

/**
 * The PUT body: every brand of the draft, so a legacy profile brand is saved into the list
 * with its domains (it stays tracked if the profile is later changed).
 */
export function toInput(draft: readonly BrandDraft[]): RadarBrandInput[] {
  return draft.map(({ label, domains }) => ({ label, domains: [...domains] }))
}

/**
 * Whether the draft differs from what was loaded (a real edit: added, removed or re-domained
 * brand). A legacy profile brand is part of the loaded state, not a change: it is written into
 * the list with the next real save.
 */
export function needsSave(draft: readonly BrandDraft[], saved: readonly BrandDraft[]): boolean {
  return JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(saved))
}
