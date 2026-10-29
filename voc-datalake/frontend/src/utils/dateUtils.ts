/**
 * @fileoverview Safe date formatting utilities.
 * @module utils/dateUtils
 */

import { format, isValid, parseISO, startOfDay, subDays } from 'date-fns'
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
  '14d': '14 Days',
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

/** A timestamp as the API sends it (ISO string) or a Date; missing or empty reads as unknown. */
type DateInput = string | Date | null | undefined
/** `long` carries the year; `short` leaves it out (compact, recent items). */
type FormatStyle = 'long' | 'short'

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/u

/**
 * A timestamp that parses, else null (missing, empty or not a date).
 *
 * A date-only `YYYY-MM-DD` is a calendar day and is read as LOCAL midnight
 * (`parseISO`): `new Date('2026-10-18')` is UTC midnight, which every zone west
 * of UTC shows as Oct 17. Anything with a time keeps `new Date` semantics.
 */
function parsedDate(value: DateInput): Date | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return isValid(value) ? value : null
  const date = CALENDAR_DAY.test(value) ? parseISO(value) : new Date(value)
  return isValid(date) ? date : null
}

/** `options` applied to `value` in the reader's locale; `fallback` when it does not parse. */
function formatIn(value: DateInput, language: string, options: Intl.DateTimeFormatOptions, fallback: string): string {
  const date = parsedDate(value)
  return date === null ? fallback : new Intl.DateTimeFormat(language || 'en', options).format(date)
}

const DATE_OPTIONS: Record<FormatStyle, Intl.DateTimeFormatOptions> = {
  long: { dateStyle: 'medium' },
  short: { month: 'short', day: 'numeric' },
}

/**
 * A timestamp's day as the reader's locale writes it: `long` = "Oct 18, 2026" (pl "18 paź 2026",
 * de "18.10.2026"), `short` = "Oct 18" (compact lists). `fallback` when it is missing or does not parse.
 * The ONE way to show a date: never a hand-built date-fns pattern, which is English whatever the language.
 */
export function formatDate(value: DateInput, language: string, fallback = '', style: FormatStyle = 'long'): string {
  return formatIn(value, language, DATE_OPTIONS[style], fallback)
}

/** A timestamp's clock time in the reader's locale ("9:05 AM", de "09:05"); `fallback` when it does not parse. */
export function formatTime(value: DateInput, language: string, fallback = ''): string {
  return formatIn(value, language, { timeStyle: 'short' }, fallback)
}

const DATE_TIME_OPTIONS: Record<FormatStyle, Intl.DateTimeFormatOptions> = {
  long: { dateStyle: 'medium', timeStyle: 'short' },
  short: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
}

/**
 * A timestamp as the reader's locale writes a date and time: `long` = "Oct 18, 2026, 9:05 AM",
 * `short` = "Oct 18, 9:05 AM" (no year: recent items). `fallback` when it is missing or does not parse.
 */
export function formatDateTime(value: DateInput, language: string, fallback = '', style: FormatStyle = 'long'): string {
  return formatIn(value, language, DATE_TIME_OPTIONS[style], fallback)
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

function capitalised(text: string, language: string): string {
  return text.charAt(0).toLocaleUpperCase(language) + text.slice(1)
}

/**
 * Recent activity as people say it, in the reader's locale: "Now", "5 min. ago", "2 hr. ago"
 * (earlier today), "Yesterday", then the date ("Oct 12"; with the year when it is not this
 * year). `fallback` when the timestamp is missing or does not parse. `nowMs` is injectable for tests.
 */
export function formatRelativeDate(value: string | null | undefined, language: string, nowMs: number = Date.now(), fallback = ''): string {
  const date = parsedDate(value)
  if (date === null) return fallback
  const lang = language || 'en'
  const relative = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' })
  const ago = nowMs - date.getTime()
  const today = startOfDay(nowMs).getTime()
  if (ago < MINUTE_MS) return capitalised(relative.format(0, 'second'), lang)
  if (ago < HOUR_MS) return relative.format(-Math.floor(ago / MINUTE_MS), 'minute')
  if (date.getTime() >= today) return relative.format(-Math.floor(ago / HOUR_MS), 'hour')
  if (date.getTime() >= subDays(today, 1).getTime()) return capitalised(relative.format(-1, 'day'), lang)
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear()
  return new Intl.DateTimeFormat(lang, sameYear ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' }).format(date)
}

/**
 * A `YYYY-MM-DD` calendar day in the reader's locale: `short` = "Oct 6" (chart ticks),
 * `long` = "Oct 6, 2026" (lists). Read as a LOCAL date, so no time zone moves it a day.
 * `fallback` (the input) when it is not such a day.
 */
export function formatCalendarDay(day: string, language: string, style: 'short' | 'long' = 'long'): string {
  if (!CALENDAR_DAY.test(day)) return day
  const value = parseISO(day)
  if (!isValid(value) || format(value, 'yyyy-MM-dd') !== day) return day
  const options: Intl.DateTimeFormatOptions = style === 'short'
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' }
  return new Intl.DateTimeFormat(language || 'en', options).format(value)
}
