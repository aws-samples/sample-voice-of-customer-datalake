/**
 * @fileoverview Shared utilities for Scrapers page components.
 * @module pages/Scrapers/scraper-helpers
 */

/**
 * Plugins served by `/integrations/{source}/apps`. Mirrors APP_CONFIG_PLUGINS in
 * lambda/api/integrations_handler.py (and mock-server.js): any other source answers
 * 400 there, so nothing may ask it for app configs.
 */
const APP_CONFIG_PLUGIN_IDS: ReadonlySet<string> = new Set(['app_reviews_ios', 'app_reviews_android'])

/** Whether a plugin keeps a list of app configs (and so has the app editor). */
export function supportsAppConfigs(pluginId: string): boolean {
  return APP_CONFIG_PLUGIN_IDS.has(pluginId)
}

/** One configured app of a multi-instance plugin (iOS/Android app reviews), as the API returns it. */
export type AppConfig = Record<string, string>

/**
 * The record's own value for `key`, or `undefined`. The index signature promises a value for
 * every key, but a wire record holds only the keys that were sent — and `Object.hasOwn` keeps an
 * inherited name (`'constructor'`) from answering for a missing one.
 */
export function ownValue<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** A field of an app config, `''` when the record does not carry it. */
export function appField(app: AppConfig, key: string): string {
  return ownValue(app, key) ?? ''
}

export function getAppIdentifier(app: AppConfig, pluginId: string): string {
  if (pluginId === 'app_reviews_ios') return appField(app, 'app_id')
  if (pluginId === 'app_reviews_android') return appField(app, 'package_name')
  return ''
}

export function getFrequencyLabel(minutes: number): string {
  if (minutes === 0) return 'Manual only'
  if (minutes < 60) return `Every ${minutes}m`
  if (minutes === 60) return 'Every hour'
  if (minutes < 1440) return `Every ${minutes / 60}h`
  return 'Daily'
}

/**
 * Reviews that will be imported (non-empty text) but carry no date. The manual
 * import confirm route refuses the whole batch (400) when this is not zero.
 */
export function countMissingDates(reviews: ReadonlyArray<{ text: string; date: string | null }>): number {
  return reviews.filter((r) => r.text.trim() !== '' && (r.date == null || r.date === '')).length
}

/** Reviews that will be imported whose date is the import-date default (no date in the text). */
export function countDefaultedDates(reviews: ReadonlyArray<{ text: string; date: string | null; date_defaulted?: boolean }>): number {
  return reviews.filter((r) => r.text.trim() !== '' && r.date_defaulted === true && r.date != null && r.date !== '').length
}
