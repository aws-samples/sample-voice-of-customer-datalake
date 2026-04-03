/**
 * @fileoverview Shared source platform display utilities.
 * @module lib/sourceFormat
 */

/**
 * Emoji icons for each data source platform.
 *
 * Covers all built-in sources and plugin-provided source_platform values.
 * When adding a new plugin/source, add its source_platform key here.
 */
const SOURCE_ICONS: { [key: string]: string | undefined } = {
  // Web scrapers
  web_scrape: '🌐',
  web_scrape_jsonld: '🌐',
  webscraper: '🌐',
  // Import sources
  manual_import: '📝',
  s3_import: '📦',
  // Feedback forms
  feedback_form: '📋',
  // Chrome extension
  chrome_extension: '🧩',
  // App review plugins
  app_reviews_android: '🤖',
  app_reviews_ios: '🍎',
}

/** Get the emoji icon for a source platform, with optional channel fallback. */
export function getSourceIcon(platform: string, channel?: string): string {
  return SOURCE_ICONS[platform] ?? SOURCE_ICONS[channel ?? ''] ?? '📝'
}

/**
 * Format a source platform slug into a human-readable name.
 *
 * When a translation function `t` is provided, scraper sources use the
 * given `i18nKey` for localized output. Without `t`, falls back to
 * a plain English label.
 */
export function formatSourceName(
  source: string,
  t?: (key: string) => string,
  i18nKey?: string,
): string {
  if (source.startsWith('scraper_') || source === 'web_scrape' || source === 'web_scrape_jsonld' || source === 'webscraper') {
    return (t != null && i18nKey != null && i18nKey !== '') ? t(i18nKey) : 'Web Scraper'
  }
  return source.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
