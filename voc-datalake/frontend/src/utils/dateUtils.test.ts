/**
 * @fileoverview Tests for safe date formatting utilities.
 */

import { describe, it, expect } from 'vitest'
import { safeFormatDate, getTimeRangeLabel } from './dateUtils'

describe('safeFormatDate', () => {
  const formatStr = 'MMM d, yyyy HH:mm'

  it('formats a valid date string correctly', () => {
    const result = safeFormatDate('2025-01-15T10:30:00Z', formatStr)
    expect(result).toMatch(/Jan 15, 2025/)
  })

  it('formats a valid Date object correctly', () => {
    const date = new Date('2025-06-20T14:00:00Z')
    const result = safeFormatDate(date, formatStr)
    expect(result).toMatch(/Jun 20, 2025/)
  })

  it('returns fallback for null', () => {
    const result = safeFormatDate(null, formatStr)
    expect(result).toBe('N/A')
  })

  it('returns fallback for undefined', () => {
    const result = safeFormatDate(undefined, formatStr)
    expect(result).toBe('N/A')
  })

  it('returns fallback for empty string', () => {
    const result = safeFormatDate('', formatStr)
    expect(result).toBe('N/A')
  })

  it('returns fallback for invalid date string', () => {
    const result = safeFormatDate('not-a-date', formatStr)
    expect(result).toBe('N/A')
  })

  it('returns fallback for Invalid Date object', () => {
    const result = safeFormatDate(new Date('invalid'), formatStr)
    expect(result).toBe('N/A')
  })

  it('uses custom fallback when provided', () => {
    const result = safeFormatDate(null, formatStr, 'Unknown')
    expect(result).toBe('Unknown')
  })

  it('handles ISO date strings with timezone', () => {
    const result = safeFormatDate('2025-12-25T00:00:00+05:00', 'yyyy-MM-dd')
    expect(result).toMatch(/2025-12-2[45]/)
  })
})

describe('getTimeRangeLabel', () => {
  it('maps preset tokens to human-readable labels', () => {
    expect(getTimeRangeLabel('24h')).toBe('24 Hours')
    expect(getTimeRangeLabel('48h')).toBe('48 Hours')
    expect(getTimeRangeLabel('7d')).toBe('7 Days')
    expect(getTimeRangeLabel('30d')).toBe('30 Days')
  })

  it('presents the "all" token as the 90 Days preset (never the raw token)', () => {
    expect(getTimeRangeLabel('all')).toBe('90 Days')
  })

  it('formats custom ranges as "Last N days" when customDays is set', () => {
    expect(getTimeRangeLabel('custom', 14)).toBe('Last 14 days')
  })

  it('falls back to "Custom" when custom is selected without a day count', () => {
    expect(getTimeRangeLabel('custom')).toBe('Custom')
    expect(getTimeRangeLabel('custom', null)).toBe('Custom')
  })

  it('falls back to the raw token for unknown values', () => {
    expect(getTimeRangeLabel('90d')).toBe('90d')
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
