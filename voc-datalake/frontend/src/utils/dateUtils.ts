/**
 * @fileoverview Safe date formatting utilities.
 * @module utils/dateUtils
 */

import { format, isValid } from 'date-fns'
import { ALL_TIME_CUSTOM_DAYS } from '../api/baseUrl'
import type { DateBasis } from '../api/types'

/**
 * Human-readable labels for the time-range tokens stored in the config store.
 *
 * Mirrors the `fullLabel` values in `TimeRangeSelector`. `'90d'` is the widest
 * fixed preset and `'all'` is all time (days=0); the bare token must never be
 * shown to users.
 */
const TIME_RANGE_LABELS: Record<string, string> = {
  '24h': '24 Hours',
  '48h': '48 Hours',
  '7d': '7 Days',
  '30d': '30 Days',
  '90d': '90 Days',
  all: 'All time',
}

/**
 * Maps a stored time-range token to a human-readable label for display
 * (e.g. PDF report headers).
 *
 * - Known presets map to their descriptive label.
 * - `'custom'` becomes `Last N days` when `customDays` is set, else `Custom`.
 * - Unknown tokens fall back to the token itself.
 * - When `dateBasis` is 'review', the label notes that the window applies to
 *   review dates instead of the (default) imported dates.
 */
/** Base label for a time-range token, before any date-basis annotation. */
function baseTimeRangeLabel(timeRange: string, customDays?: number | null): string {
  if (timeRange === 'custom') {
    if (customDays == null) return 'Custom'
    return customDays === ALL_TIME_CUSTOM_DAYS ? 'All time' : `Last ${customDays} days`
  }
  return TIME_RANGE_LABELS[timeRange] ?? timeRange
}

export function getTimeRangeLabel(
  timeRange: string,
  customDays?: number | null,
  dateBasis?: DateBasis
): string {
  const baseLabel = baseTimeRangeLabel(timeRange, customDays)
  return dateBasis === 'review' ? `${baseLabel} (by review date)` : baseLabel
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
