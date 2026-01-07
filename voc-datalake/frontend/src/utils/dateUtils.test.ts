/**
 * @fileoverview Tests for safe date formatting utilities.
 */

import { describe, it, expect } from 'vitest'
import { safeFormatDate } from './dateUtils'

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
