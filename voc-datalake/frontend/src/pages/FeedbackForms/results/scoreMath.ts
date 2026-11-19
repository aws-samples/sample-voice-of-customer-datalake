/**
 * @fileoverview The figures of a scale question's results (UX §10.2): its distribution over every point of the
 * scale, the average, NPS (−100 to 100: promoters 9–10 minus detractors 0–6, as shares), CSAT's "% satisfied" (4–5)
 * and CES's "% easy" (5–7).
 *
 * @module pages/FeedbackForms/results/scoreMath
 */

export interface ScoreCount {
  readonly score: number
  readonly count: number
}

/** Every point from `min` to `max` with its count (0 where none answered it). */
export function distributionRows(distribution: Readonly<Record<string, number>> | undefined, min: number, max: number): ScoreCount[] {
  return Array.from({ length: max - min + 1 }, (_unused, index) => {
    const score = min + index
    return { score, count: distribution?.[String(score)] ?? 0 }
  })
}

export const totalOf = (rows: readonly ScoreCount[]): number => rows.reduce((sum, row) => sum + row.count, 0)

/** The average score (null with no answers). */
export function averageOf(rows: readonly ScoreCount[]): number | null {
  const total = totalOf(rows)
  return total === 0 ? null : rows.reduce((sum, row) => sum + row.score * row.count, 0) / total
}

/** How many answered `from` or above. */
export const countFrom = (rows: readonly ScoreCount[], from: number): number =>
  rows.filter((row) => row.score >= from).reduce((sum, row) => sum + row.count, 0)

/** A share in percent (0 with nothing to share). */
export const percentOf = (part: number, whole: number): number => (whole === 0 ? 0 : (part / whole) * 100)

export interface NpsGroups {
  readonly detractors: number
  readonly passives: number
  readonly promoters: number
  readonly total: number
  /** −100 to 100, rounded; null with no answers. */
  readonly score: number | null
}

export function npsGroups(rows: readonly ScoreCount[]): NpsGroups {
  const total = totalOf(rows)
  const detractors = rows.filter((row) => row.score <= 6).reduce((sum, row) => sum + row.count, 0)
  const promoters = countFrom(rows, 9)
  return {
    detractors, promoters, total,
    passives: total - detractors - promoters,
    score: total === 0 ? null : Math.round(((promoters - detractors) / total) * 100),
  }
}

/** An NPS score signed as people write it ("+32", "−8", "0"). */
export function signedScore(score: number): string {
  if (score > 0) return `+${String(score)}`
  return score < 0 ? `−${String(Math.abs(score))}` : '0'
}
