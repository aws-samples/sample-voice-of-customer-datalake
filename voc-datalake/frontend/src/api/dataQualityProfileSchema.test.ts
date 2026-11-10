import { describe, expect, it } from 'vitest'
import { normalizeDataQuality } from './dataQualitySchema'
import { emptyProfile, normalizeProfile } from './dataQualityProfileSchema'

describe('normalizeProfile', () => {
  it('keeps every known value, drops unknown ones and reads a bad count as 0', () => {
    const profile = normalizeProfile({
      profiled: 4,
      rating: { 5: 3, none: 1, 9: 7 },
      sentiment: { negative: '4', joyful: 2 },
      length: { short: -1, very_long: 3 },
    })
    expect(profile.profiled).toBe(4)
    expect(profile.rating).toStrictEqual({ 5: 3, 4: 0, 3: 0, 2: 0, 1: 0, none: 1 })
    expect(profile.sentiment).toStrictEqual({ positive: 0, neutral: 0, mixed: 0, negative: 4, other: 0 })
    const { length: textLength } = profile
    expect(textLength).toStrictEqual({ short: 0, medium: 0, long: 0, very_long: 3 })
  })

  it.each([undefined, null, 'x', { profiled: 'many', rating: 'x' }])('reads %j as an empty or partial profile', (raw) => {
    expect(normalizeProfile(raw).rating).toStrictEqual(emptyProfile().rating)
  })

  it('re-sums the all-sources profile from the kept rows', () => {
    const profile = (five: number) => ({ profiled: five, rating: { 5: five } })
    const result = normalizeDataQuality({
      sources: [
        { source: 'web', high: 2, medium: 0, low: 0, unrated: 0, total: 2, profile: profile(2) },
        { source: 'app', high: 1, medium: 0, low: 0, unrated: 0, total: 1, profile: profile(1) },
        { source: '', high: 9, total: 9, profile: profile(9) },
      ],
      overall: { profile: profile(99) },
    })
    expect(result.overall.profile.profiled).toBe(3)
    expect(result.overall.profile.rating['5']).toBe(3)
  })
})
