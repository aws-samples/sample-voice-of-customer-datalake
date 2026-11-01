/**
 * The comparison's wire shape (GET /radar/brands/{brand}/page `compare`): `overall` (both sides over
 * the window; null on an older API or when malformed) and each row's `too_few` (derived from their
 * volume when absent), whose row carries no verdict.
 */
import { describe, expect, it } from 'vitest'
import { normalizeRadarPage } from './radarSchema'

const side = (volume: number, positive: number | null) => ({ volume, positive_share: positive, negative_share: 0.2 })
const compareOf = (raw: unknown) => normalizeRadarPage({ compare: raw }).compare

describe('Radar compare schema', () => {
  it('reads the overall sides', () => {
    expect(compareOf({ overall: { theirs: side(28, 0.5), ours: side(120, 0.55) } }).overall)
      .toStrictEqual({ theirs: side(28, 0.5), ours: side(120, 0.55) })
  })

  it('reads a missing side of ours as null, a missing or malformed overall as null', () => {
    expect(compareOf({ overall: { theirs: side(28, 0.5) } }).overall?.ours).toBeNull()
    expect(compareOf({ categories: [] }).overall).toBeNull()
    expect(compareOf({ overall: 'nope' }).overall).toBeNull()
    expect(compareOf(undefined)).toStrictEqual({ categories: [], ours_available: false, overall: null })
  })

  it('keeps the API\'s too_few and drops the verdict of a too-few row', () => {
    const [row] = compareOf({ categories: [{ category: 'delivery', theirs: side(12, 0.8), ours: null, verdict: 'they_are_better', too_few: true }] }).categories
    expect(row).toMatchObject({ too_few: true, verdict: null })
  })

  it('derives too_few from their volume on an older API', () => {
    const rows = compareOf({ categories: [
      { category: 'few', theirs: side(9, 0.8), ours: side(40, 0.5), verdict: 'they_are_better' },
      { category: 'enough', theirs: side(10, 0.8), ours: side(40, 0.5), verdict: 'they_are_better' },
    ] }).categories
    expect(rows.map((row) => [row.category, row.too_few, row.verdict])).toStrictEqual([
      ['few', true, null], ['enough', false, 'they_are_better'],
    ])
  })

  it('reads a malformed too_few as absent', () => {
    const [row] = compareOf({ categories: [{ category: 'x', theirs: side(30, 0.5), ours: null, verdict: 'even', too_few: 'yes' }] }).categories
    expect(row).toMatchObject({ too_few: false, verdict: 'even' })
  })
})
