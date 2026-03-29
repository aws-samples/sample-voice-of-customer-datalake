/**
 * @fileoverview Shared utilities for Scrapers page components.
 * @module pages/Scrapers/scraper-helpers
 */

type AppConfig = Record<string, string>

export function getAppIdentifier(app: AppConfig, pluginId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- keys may be undefined at runtime
  if (pluginId === 'app_reviews_ios') return app.app_id ?? ''
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- keys may be undefined at runtime
  if (pluginId === 'app_reviews_android') return app.package_name ?? ''
  return ''
}

export function getFrequencyLabel(minutes: number): string {
  if (minutes === 0) return 'Manual only'
  if (minutes < 60) return `Every ${minutes}m`
  if (minutes === 60) return 'Every hour'
  if (minutes < 1440) return `Every ${minutes / 60}h`
  return 'Daily'
}
