/**
 * @fileoverview The pure reads behind the Radar summary strip (RadarSummary): the releases of the
 * window, the biggest category gap between them and us, and whether the overall shares compare.
 * @module pages/Radar/radarReads
 */
import { RADAR_COMPARE_MIN_REVIEWS } from '../../api/radarSchema'
import type { RadarCompare, RadarCompareRow, RadarCompareSide, RadarRelease } from '../../api/radarSchema'

const DAY_MS = 86_400_000

/** `YYYY-MM-DD` of the UTC day `days` before `now` (the API's days are UTC calendar days). */
export function utcDayBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10)
}

/** Releases newest first (an ISO day sorts as text); ties keep their order. */
export function newestFirst<T extends Pick<RadarRelease, 'release_date'>>(releases: readonly T[]): T[] {
  return [...releases].sort((a, b) => b.release_date.localeCompare(a.release_date))
}

/** The releases dated inside the last `days` days (today included), newest first. */
export function releasesInWindow<T extends Pick<RadarRelease, 'release_date'>>(releases: readonly T[], days: number, now = new Date()): T[] {
  const since = utcDayBefore(now, days - 1)
  return newestFirst(releases.filter((release) => release.release_date >= since))
}

/** The biggest gap of positive share between them and us: who leads, where, and by how many points. */
export interface CompareGap {
  readonly category: string
  readonly leader: 'they' | 'we' | 'even'
  readonly points: number
}

function gapOf(row: RadarCompareRow): CompareGap | null {
  const theirs = row.theirs.positive_share
  const ours = row.ours?.positive_share ?? null
  if (row.too_few || theirs === null || ours === null || (row.ours?.volume ?? 0) === 0) return null
  const points = Math.round(Math.abs(theirs - ours) * 100)
  if (points === 0) return { category: row.category, leader: 'even', points }
  return { category: row.category, leader: theirs > ours ? 'they' : 'we', points }
}

/** The comparable row with the largest gap; null when no row compares (too few reviews, or no side of ours). */
export function biggestGap(rows: readonly RadarCompareRow[]): CompareGap | null {
  return rows.reduce<CompareGap | null>((best, row) => {
    const gap = gapOf(row)
    return gap !== null && (best === null || gap.points > best.points) ? gap : best
  }, null)
}

/** How the overall shares read: why they do not compare, or both sides. */
export type OverallReading =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'tooFew'; readonly theirs: RadarCompareSide }
  | { readonly kind: 'noOurs'; readonly theirs: RadarCompareSide }
  | { readonly kind: 'compare'; readonly theirs: RadarCompareSide; readonly ours: RadarCompareSide }

export function readOverall(compare: RadarCompare): OverallReading {
  const overall = compare.overall
  if (overall === null) return { kind: 'unknown' }
  const { theirs, ours } = overall
  if (theirs.volume < RADAR_COMPARE_MIN_REVIEWS || theirs.positive_share === null) return { kind: 'tooFew', theirs }
  if (ours === null || ours.volume === 0 || ours.positive_share === null) return { kind: 'noOurs', theirs }
  return { kind: 'compare', theirs, ours }
}
