/**
 * @fileoverview The per-source profile inside `GET /metrics/data-quality` (lambda/shared/source_profile.py):
 * counts per star rating, sentiment and text-length bucket, and how many reviews were profiled. Lenient:
 * an absent or malformed profile reads as empty, an unknown value is dropped, a bad count reads 0.
 * @module api/dataQualityProfileSchema
 */
import { z } from 'zod'
import { toOptionalFiniteNumber } from './lenientFields'

export const PROFILE_FACETS = ['rating', 'sentiment', 'length'] as const
export type ProfileFacet = typeof PROFILE_FACETS[number]

/** Each facet's values in display order (the API's value ids). */
export const PROFILE_VALUES: Readonly<Record<ProfileFacet, readonly string[]>> = {
  rating: ['5', '4', '3', '2', '1', 'none'],
  sentiment: ['positive', 'neutral', 'mixed', 'negative', 'other'],
  length: ['short', 'medium', 'long', 'very_long'],
}

/** One facet's count per value id: every id of `PROFILE_VALUES[facet]` is present. */
export type FacetCounts = Readonly<Record<string, number>>

export interface SourceProfile {
  /** Reviews counted in the profile; reviews stored before the counters existed are not. */
  readonly profiled: number
  readonly rating: FacetCounts
  readonly sentiment: FacetCounts
  readonly length: FacetCounts
}

/** A whole, non-negative count; absent, junk or negative reads as 0. */
export const count = z.unknown().transform((value) => Math.max(Math.round(toOptionalFiniteNumber(value) ?? 0), 0))

const FacetSchema = z.record(z.string(), count).catch({})
const ProfileSchema = z.object({ profiled: count, rating: FacetSchema, sentiment: FacetSchema, length: FacetSchema })

/** Exactly the facet's value ids, each from `raw` or 0 (an unknown id is dropped). */
function facetCounts(facet: ProfileFacet, raw: FacetCounts): FacetCounts {
  return Object.fromEntries(PROFILE_VALUES[facet].map((value) => [value, raw[value] ?? 0]))
}

export function emptyProfile(): SourceProfile {
  return { profiled: 0, rating: facetCounts('rating', {}), sentiment: facetCounts('sentiment', {}), length: facetCounts('length', {}) }
}

export function normalizeProfile(raw: unknown): SourceProfile {
  const parsed = ProfileSchema.safeParse(raw)
  if (!parsed.success) return emptyProfile()
  const { profiled, rating, sentiment, length } = parsed.data
  return {
    profiled,
    rating: facetCounts('rating', rating),
    sentiment: facetCounts('sentiment', sentiment),
    length: facetCounts('length', length),
  }
}

function summedFacet(facet: ProfileFacet, profiles: readonly SourceProfile[]): FacetCounts {
  return Object.fromEntries(PROFILE_VALUES[facet].map((value) => [
    value, profiles.reduce((sum, profile) => sum + (profile[facet][value] ?? 0), 0),
  ]))
}

/** The all-sources profile, re-summed from the kept rows. */
export function sumProfiles(profiles: readonly SourceProfile[]): SourceProfile {
  return {
    profiled: profiles.reduce((sum, profile) => sum + profile.profiled, 0),
    rating: summedFacet('rating', profiles),
    sentiment: summedFacet('sentiment', profiles),
    length: summedFacet('length', profiles),
  }
}
