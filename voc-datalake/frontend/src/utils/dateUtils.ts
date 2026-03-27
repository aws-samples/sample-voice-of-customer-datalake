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
