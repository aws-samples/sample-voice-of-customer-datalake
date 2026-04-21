/**
 * @fileoverview Safe date formatting utilities.
 * @module utils/dateUtils
 */

import {
  format, isValid, parseISO,
} from 'date-fns'

/**
 * Safely formats a date string or Date object.
 * Returns a fallback string if the date is invalid.
 */
export function safeFormatDate(
  dateValue: string | Date | null | undefined,
  formatStr: string,
  fallback = 'N/A',
): string {
  if (dateValue == null) return fallback

  const date = typeof dateValue === 'string' ? new Date(dateValue) : dateValue

  if (!isValid(date)) return fallback

  return format(date, formatStr)
}

/**
 * Formats an ISO date string using parseISO for strict parsing.
 * Prefer this for API-returned ISO strings.
 */
export function formatISODate(
  dateStr: string | undefined,
  formatStr: string,
  fallback = 'N/A',
): string {
  if (dateStr == null || dateStr === '') return fallback
  try {
    const date = parseISO(dateStr)
    return isValid(date) ? format(date, formatStr) : fallback
  } catch {
    return fallback
  }
}

const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Validates that a Date object matches the expected year/month/day components.
 * Guards against JS date rollover (e.g. Feb 30 → Mar 2).
 */
function isDateComponentMatch(date: Date, year: number, month: number, day: number): boolean {
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

/**
 * Parses a `YYYY-MM-DD` date-only string as a local Date (midnight local time).
 * Use this for calendar date inputs where the user meant the literal day in
 * their timezone, not a UTC instant. Returns null when the input is missing
 * or malformed.
 */
export function parseLocalDate(dateStr: string | null | undefined): Date | null {
  if (dateStr == null || dateStr === '') return null
  const match = DATE_REGEX.exec(dateStr)
  if (!match) return null
  const [, yearStr, monthStr, dayStr] = match
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(year, month - 1, day)
  if (!isDateComponentMatch(date, year, month, day)) return null
  return isValid(date) ? date : null
}
