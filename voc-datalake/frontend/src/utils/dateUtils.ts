/**
 * @fileoverview Safe date formatting utilities.
 * @module utils/dateUtils
 */

import { format, isValid } from 'date-fns'

/**
 * Human-readable labels for the time-range tokens stored in the config store.
 *
 * Mirrors the `fullLabel` values in `TimeRangeSelector`. Note the `'all'` token
 * is presented as the "90 Days" preset (the max window, matching the aggregates
 * 90-day TTL); the bare token must never be shown to users.
 */
const TIME_RANGE_LABELS: Record<string, string> = {
  '24h': '24 Hours',
  '48h': '48 Hours',
  '7d': '7 Days',
  '30d': '30 Days',
  all: '90 Days',
}

/**
 * Maps a stored time-range token to a human-readable label for display
 * (e.g. PDF report headers).
 *
 * - Known presets map to their descriptive label.
 * - `'custom'` becomes `Last N days` when `customDays` is set, else `Custom`.
 * - Unknown tokens fall back to the token itself.
 */
export function getTimeRangeLabel(
  timeRange: string,
  customDays?: number | null
): string {
  if (timeRange === 'custom') {
    return customDays != null ? `Last ${customDays} days` : 'Custom'
  }
  return TIME_RANGE_LABELS[timeRange] ?? timeRange
}

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
