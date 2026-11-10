/**
 * @fileoverview Lenient wire boundary of `GET /metrics/data-quality` (lambda/shared/data_quality.py):
 * the per-source usefulness distribution and profile (lambda/shared/source_profile.py). A malformed
 * source row is dropped, a bad count reads 0, `total` is never below the bands it holds, and a row
 * without a profile (an older API) gets an empty one, so the section never renders a negative share.
 * @module api/dataQualitySchema
 */
import { z } from 'zod'
import { count, emptyProfile, normalizeProfile, sumProfiles } from './dataQualityProfileSchema'
import type { SourceProfile } from './dataQualityProfileSchema'

/** The stored bands, best first, then the reviews stored before the band existed. */
export const QUALITY_BANDS = ['high', 'medium', 'low', 'unrated'] as const
export type QualityBand = typeof QUALITY_BANDS[number]

export type QualityCounts = Readonly<Record<QualityBand, number> & { total: number }>

export interface SourceQuality extends QualityCounts {
  readonly source: string
  readonly profile: SourceProfile
}

export type OverallQuality = QualityCounts & { readonly profile: SourceProfile }

export interface DataQuality {
  readonly isPartial: boolean
  /** Busiest source first (the API's order). */
  readonly sources: readonly SourceQuality[]
  readonly overall: OverallQuality
}

/** The share of `part` in `total` as 0–100 (0 for an empty total). */
export function shareOf(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0
}

const CountsSchema = z.object({ high: count, medium: count, low: count, unrated: count, total: count })
const SourceSchema = CountsSchema.extend({ source: z.string().min(1), profile: z.unknown().optional() })
const ResponseSchema = z.object({
  is_partial: z.boolean().catch(false),
  sources: z.array(z.unknown()).catch([]),
})

const EMPTY: OverallQuality = { high: 0, medium: 0, low: 0, unrated: 0, total: 0, profile: emptyProfile() }

function consistent<T extends QualityCounts>(counts: T): T {
  const banded = QUALITY_BANDS.reduce((sum, band) => sum + counts[band], 0)
  return { ...counts, total: Math.max(counts.total, banded) }
}

function sumOf(sources: readonly SourceQuality[]): OverallQuality {
  const total = (field: QualityBand | 'total') => sources.reduce((sum, row) => sum + row[field], 0)
  return {
    high: total('high'), medium: total('medium'), low: total('low'), unrated: total('unrated'), total: total('total'),
    profile: sumProfiles(sources.map((row) => row.profile)),
  }
}

/** Normalize the response. `overall` is re-summed from the kept rows, so the two always agree. */
export function normalizeDataQuality(raw: unknown): DataQuality {
  const parsed = ResponseSchema.safeParse(raw)
  if (!parsed.success) return { isPartial: false, sources: [], overall: EMPTY }
  const sources = parsed.data.sources.flatMap((entry) => {
    const row = SourceSchema.safeParse(entry)
    return row.success ? [consistent({ ...row.data, profile: normalizeProfile(row.data.profile) })] : []
  }).filter((row) => row.total > 0)
  return { isPartial: parsed.data.is_partial, sources, overall: sumOf(sources) }
}
