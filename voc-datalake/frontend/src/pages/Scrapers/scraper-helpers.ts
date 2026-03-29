/**
 * @fileoverview Shared utilities for Scrapers page components.
 * @module pages/Scrapers/utils
 */

type AppConfig = Record<string, string>

export function getAppIdentifier(app: AppConfig, pluginId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- keys may be undefined at runtime
  if (pluginId === 'app_reviews_ios') return app.app_id ?? ''
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- keys may be undefined at runtime
  if (pluginId === 'app_reviews_android') return app.package_name ?? ''
  return ''
}
