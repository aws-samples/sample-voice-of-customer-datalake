/**
 * The summary strip's reads: the releases of the window (today included, newest first), the
 * biggest comparable gap (too few or no side of ours never counts) and how the overall shares read.
 */
import { describe, expect, it } from 'vitest'
import { biggestGap, newestFirst, readOverall, releasesInWindow, utcDayBefore } from './radarReads'
import { normalizeRadarPage } from '../../api/radarSchema'
import type { RadarCompare } from '../../api/radarSchema'

const NOW = new Date('2026-11-01T12:00:00Z')
const side = (volume: number, positive: number | null) => ({ volume, positive_share: positive, negative_share: 0.1 })
const compareOf = (raw: unknown): RadarCompare => normalizeRadarPage({ compare: raw }).compare
const rows = (...categories: unknown[]) => compareOf({ ours_available: true, categories }).categories
const row = (category: string, theirs: ReturnType<typeof side>, ours: ReturnType<typeof side> | null) =>
  ({ category, theirs, ours, verdict: 'even' })

describe('releasesInWindow', () => {
  const at = (day: string) => ({ release_date: day })

  it('keeps the releases of the last N days, today included, newest first', () => {
    const releases = [at('2026-10-02'), at('2026-11-01'), at('2026-10-03'), at('2026-10-20')]
    expect(releasesInWindow(releases, 30, NOW).map((r) => r.release_date)).toStrictEqual(['2026-11-01', '2026-10-20', '2026-10-03'])
  })

  it('answers none when nothing is that recent', () => {
    expect(releasesInWindow([at('2026-01-01')], 7, NOW)).toStrictEqual([])
  })

  it('sorts newest first without moving equal days', () => {
    const list = [{ release_date: '2026-10-01', id: 'a' }, { release_date: '2026-10-05', id: 'b' }, { release_date: '2026-10-01', id: 'c' }]
    expect(newestFirst(list).map((r) => r.id)).toStrictEqual(['b', 'a', 'c'])
  })

  it('counts days back in UTC', () => {
    expect(utcDayBefore(NOW, 0)).toBe('2026-11-01')
    expect(utcDayBefore(NOW, 31)).toBe('2026-10-01')
  })
})

describe('biggestGap', () => {
  it('finds the comparable row with the largest gap, in points, and who leads it', () => {
    const gap = biggestGap(rows(
      row('delivery', side(20, 0.8), side(40, 0.55)),
      row('support', side(15, 0.2), side(30, 0.6)),
    ))
    expect(gap).toStrictEqual({ category: 'support', leader: 'we', points: 40 })
  })

  it('says they lead when their share is higher', () => {
    expect(biggestGap(rows(row('delivery', side(20, 0.8), side(40, 0.55))))).toStrictEqual({ category: 'delivery', leader: 'they', points: 25 })
  })

  it('reads a gap under half a point as even', () => {
    expect(biggestGap(rows(row('pricing', side(20, 0.501), side(40, 0.5))))?.leader).toBe('even')
  })

  it('never counts a row with too few of their reviews, without ours or without a share', () => {
    expect(biggestGap(rows(
      row('few', side(3, 1), side(40, 0)),
      row('no-ours', side(30, 0.9), null),
      row('empty-ours', side(30, 0.9), side(0, null)),
      row('no-share', side(30, null), side(40, 0.5)),
    ))).toBeNull()
  })
})

describe('readOverall', () => {
  it('is unknown when the API sends no overall (an older API)', () => {
    expect(readOverall(compareOf({ categories: [] }))).toStrictEqual({ kind: 'unknown' })
  })

  it('is too few under 10 of their reviews', () => {
    expect(readOverall(compareOf({ overall: { theirs: side(6, 0.5), ours: side(100, 0.5) } })).kind).toBe('tooFew')
  })

  it('has no side of ours when ours is null or empty', () => {
    expect(readOverall(compareOf({ overall: { theirs: side(20, 0.5), ours: null } })).kind).toBe('noOurs')
    expect(readOverall(compareOf({ overall: { theirs: side(20, 0.5), ours: side(0, null) } })).kind).toBe('noOurs')
  })

  it('compares both sides otherwise', () => {
    const reading = readOverall(compareOf({ overall: { theirs: side(20, 0.6), ours: side(100, 0.5) } }))
    expect(reading).toMatchObject({ kind: 'compare', theirs: { volume: 20 }, ours: { volume: 100 } })
  })
})
