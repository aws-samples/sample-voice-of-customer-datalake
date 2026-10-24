/**
 * @fileoverview Tests for safe date formatting utilities.
 */

import { describe, it, expect } from 'vitest'
import { formatCalendarDay, formatDate, formatDateTime, formatTime, getTimeRangeLabel } from './dateUtils'

describe('formatDate', () => {
  // Noon UTC: the same calendar day in every CI time zone.
  const ISO = '2026-10-18T12:00:00Z'

  it('writes the day in the reader\'s language, not US English (verify10: Polish UI showed "Oct 18, 2026")', () => {
    expect(formatDate(ISO, 'en')).toBe('Oct 18, 2026')
    expect(formatDate(ISO, 'pl')).toBe(new Intl.DateTimeFormat('pl', { dateStyle: 'medium' }).format(new Date(ISO)))
    expect(formatDate(ISO, 'pl')).not.toContain('Oct')
    expect(formatDate(ISO, 'de')).toBe('18.10.2026')
  })

  it('has a short month-and-day style and takes a Date', () => {
    expect(formatDate(new Date(ISO), 'en', '', 'short')).toBe('Oct 18')
    expect(formatDate(ISO, 'fr', '', 'short')).toBe(new Intl.DateTimeFormat('fr', { month: 'short', day: 'numeric' }).format(new Date(ISO)))
  })

  it.each([null, undefined, '', 'not-a-date', new Date('invalid')])('falls back for %s', (value) => {
    expect(formatDate(value, 'en', '—')).toBe('—')
  })

  it('treats an empty language as English', () => {
    expect(formatDate(ISO, '')).toBe('Oct 18, 2026')
  })
})

describe('formatTime', () => {
  const ISO = '2026-10-18T09:05:00Z'

  it('writes the clock time the locale\'s way', () => {
    expect(formatTime(ISO, 'de')).toBe(new Intl.DateTimeFormat('de', { timeStyle: 'short' }).format(new Date(ISO)))
    expect(formatTime(ISO, 'en')).toMatch(/AM|PM/u)
  })

  it('falls back when the timestamp does not parse', () => {
    expect(formatTime('soon', 'en', '—')).toBe('—')
  })
})

describe('getTimeRangeLabel', () => {
  it('maps preset tokens to human-readable labels', () => {
    expect(getTimeRangeLabel('24h')).toBe('24 Hours')
    expect(getTimeRangeLabel('48h')).toBe('48 Hours')
    expect(getTimeRangeLabel('7d')).toBe('7 Days')
    expect(getTimeRangeLabel('30d')).toBe('30 Days')
  })

  it('labels the 90d preset "90 Days" and the "all" token "All time" (never the raw token)', () => {
    expect(getTimeRangeLabel('90d')).toBe('90 Days')
    expect(getTimeRangeLabel('all')).toBe('All time')
  })

  it('formats custom ranges as "Last N days" when customDays is set', () => {
    expect(getTimeRangeLabel('custom', 14)).toBe('Last 14 days')
  })

  it('labels a custom lookback of 0 as "All time"', () => {
    expect(getTimeRangeLabel('custom', 0)).toBe('All time')
  })

  it('falls back to "Custom" when custom is selected without a day count', () => {
    expect(getTimeRangeLabel('custom')).toBe('Custom')
    expect(getTimeRangeLabel('custom', null)).toBe('Custom')
  })

  it('falls back to the raw token for unknown values', () => {
    expect(getTimeRangeLabel('365d')).toBe('365d')
  })

  it('appends the review-date note when filtering by review date', () => {
    expect(getTimeRangeLabel('7d', null, 'review')).toBe('7 Days (by review date)')
    expect(getTimeRangeLabel('custom', 14, 'review')).toBe('Last 14 days (by review date)')
  })

  it('leaves the label unchanged for the imported basis', () => {
    expect(getTimeRangeLabel('7d', null, 'imported')).toBe('7 Days')
    expect(getTimeRangeLabel('7d')).toBe('7 Days')
  })
})

describe('formatDateTime', () => {
  const ISO = '2026-10-18T09:05:00Z'

  it('writes a date and time the way the locale does, never the raw ISO string', () => {
    const expected = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ISO))
    expect(formatDateTime(ISO, 'en')).toBe(expected)
    expect(formatDateTime(ISO, 'en')).not.toContain('T09')
  })

  it('follows the language', () => {
    const expected = new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ISO))
    expect(formatDateTime(ISO, 'de')).toBe(expected)
  })

  it.each([null, undefined, '', 'not a date'])('falls back for %s', (value) => {
    expect(formatDateTime(value, 'en', '—')).toBe('—')
  })

  it('has a short style without the year, in the language', () => {
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    expect(formatDateTime(ISO, 'pl', '', 'short')).toBe(new Intl.DateTimeFormat('pl', options).format(new Date(ISO)))
    expect(formatDateTime(ISO, 'en', '', 'short')).not.toContain('2026')
  })
})

describe('formatCalendarDay', () => {
  it('writes a day as "MMM d" on charts and "MMM d, yyyy" in lists, never ISO', () => {
    expect(formatCalendarDay('2026-10-06', 'en', 'short')).toBe('Oct 6')
    expect(formatCalendarDay('2026-10-06', 'en')).toBe('Oct 6, 2026')
  })

  it('keeps the calendar day whatever the time zone (no UTC shift to the day before)', () => {
    expect(formatCalendarDay('2026-01-01', 'en')).toBe('Jan 1, 2026')
  })

  it.each(['2026-02-30', 'soon', ''])('leaves %s as it is', (value) => {
    expect(formatCalendarDay(value, 'en')).toBe(value)
  })
})

describe('date-only values west of UTC', () => {
  /** Runs `answer` with the process in `zone`, putting the ambient zone back exactly (an absent TZ is deleted, not set). */
  function inZone<T>(zone: string, answer: () => T): T {
    const before = process.env.TZ
    try {
      process.env.TZ = zone
      return answer()
    } finally {
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    }
  }

  it('reads YYYY-MM-DD as that calendar day in Los Angeles, not the day before', () => {
    const zone = inZone('America/Los_Angeles', () => new Intl.DateTimeFormat().resolvedOptions().timeZone)
    // Vacuity guard: the zone switch must take effect, or the case below proves nothing.
    expect(zone).toBe('America/Los_Angeles')
    expect(inZone('America/Los_Angeles', () => formatDate('2026-10-18', 'en'))).toBe('Oct 18, 2026')
  })

  it('still reads a UTC timestamp in the viewer\'s zone', () => {
    expect(inZone('America/Los_Angeles', () => formatDate('2026-10-18T03:00:00Z', 'en'))).toBe('Oct 17, 2026')
  })
})
