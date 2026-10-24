import { describe, expect, it } from 'vitest'
import { normalizeReleaseWatch } from './releaseWatchSchema'

const SIDE = { days: 14, count: 10, scored: 10, avg_sentiment: 0.2, negative: 3, top_categories: [{ name: 'app', count: 4 }, null] }
const RELEASE = {
  key: 'github:1.2.0', label: '1.2.0', kind: 'github_release', date: '2026-10-10', before: SIDE, after: SIDE,
  deltas: { volume_pct: 0, negative_pct: null, sentiment: -0.2 }, complaint_deltas: [{ name: 'app', before: 1, after: 3 }, 7],
  regression: true, reasons: ['sentiment_drop'], feedback_ids: ['fb_1'],
}

describe('normalizeReleaseWatch', () => {
  it('reads a full answer and drops unreadable rows', () => {
    const watch = normalizeReleaseWatch({ window_days: 14, is_partial: false, releases: [RELEASE, { key: '' }] })
    expect(watch.windowDays).toBe(14)
    expect(watch.releases.map((r) => r.key)).toStrictEqual(['github:1.2.0'])
    expect(watch.releases[0]?.before.top_categories).toStrictEqual([{ name: 'app', count: 4 }])
    expect(watch.releases[0]?.complaint_deltas).toStrictEqual([{ name: 'app', before: 1, after: 3 }])
  })

  it('degrades a sparse release to neutral values', () => {
    const watch = normalizeReleaseWatch({ releases: [{ key: 'launch:x', date: '2026-10-01', kind: 'other' }] })
    const [release] = watch.releases
    expect(release).toMatchObject({ kind: 'launch', regression: false, reasons: [], feedback_ids: [] })
    expect(release?.after).toMatchObject({ count: 0, avg_sentiment: null })
  })

  it('names how far a time-budgeted walk read', () => {
    const watch = normalizeReleaseWatch({ is_partial: true, partial_reason: 'time_budget', scanned_through: '2026-09-01' })
    expect(watch.partial).toStrictEqual({ isPartial: true, scannedThrough: '2026-09-01' })
  })

  it('reads garbage as an empty watch', () => {
    expect(normalizeReleaseWatch('nope').releases).toStrictEqual([])
  })
})
