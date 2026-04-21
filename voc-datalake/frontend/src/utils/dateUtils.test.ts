/**
 * @fileoverview Tests for safe date formatting utilities.
 */

import { describe, it, expect } from 'vitest'
import { safeFormatDate, parseLocalDate } from './dateUtils'

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

describe('parseLocalDate', () => {
  it('parses YYYY-MM-DD as the literal day in local time', () => {
    const result = parseLocalDate('2025-01-01')
    expect(result).not.toBeNull()
    // Whatever the runner's timezone, Jan 1 should stay Jan 1
    expect(result?.getFullYear()).toBe(2025)
    expect(result?.getMonth()).toBe(0)
    expect(result?.getDate()).toBe(1)
  })

  it('does not shift the day backwards in negative UTC-offset timezones', () => {
    // Regression: new Date('2025-01-01') would produce Dec 31 in EST
    const result = parseLocalDate('2025-01-15')
    expect(result?.getDate()).toBe(15)
  })

  it('returns null for null input', () => {
    expect(parseLocalDate(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(parseLocalDate(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseLocalDate('')).toBeNull()
  })

  it('returns null for malformed date strings', () => {
    expect(parseLocalDate('not-a-date')).toBeNull()
    expect(parseLocalDate('2025/01/01')).toBeNull()
    expect(parseLocalDate('2025-1-1')).toBeNull()
  })

  it('returns null for impossible calendar dates', () => {
    expect(parseLocalDate('2025-13-01')).toBeNull()
    expect(parseLocalDate('2025-02-30')).toBeNull()
    expect(parseLocalDate('2025-00-15')).toBeNull()
    expect(parseLocalDate('2025-06-32')).toBeNull()
  })
})
