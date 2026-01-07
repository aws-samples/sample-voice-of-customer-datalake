/**
 * @fileoverview Safe date formatting utilities.
 * @module utils/dateUtils
 */

import { format, isValid } from 'date-fns'

/**
 * Safely formats a date string or Date object.
 * Returns a fallback string if the date is invalid.
 */
export function safeFormatDate(
  dateValue: string | Date | null | undefined,
  formatStr: string,
  fallback = 'N/A'
): string {
  if (!dateValue) return fallback

  const date = typeof dateValue === 'string' ? new Date(dateValue) : dateValue

  if (!isValid(date)) return fallback

  return format(date, formatStr)
}
