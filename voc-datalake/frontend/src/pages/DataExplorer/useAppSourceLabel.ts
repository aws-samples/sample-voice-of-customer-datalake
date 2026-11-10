/**
 * @fileoverview An app connector's source label with the app's NAME when it is known.
 *
 * An app-review source is stored as `<app name>_Android` / `<app name>_iOS`; an app
 * saved without a name was stored under its package id, so Data Explorer listed
 * "com.acme.dreamhouse (Android)". The app configs (`GET /integrations/<plugin>/apps`,
 * the same cache entries the Data sources page reads) map that id to the name the app
 * carries now.
 *
 * @module pages/DataExplorer/useAppSourceLabel
 */
import { useQueries } from '@tanstack/react-query'
import { api } from '../../api/client'
import { appConfigsKey } from '../../api/queryKeys'

/** Each app-review plugin, the config field holding its store id, and the platform word. */
const APP_PLUGINS = [
  { pluginId: 'app_reviews_android', idField: 'package_name', platform: 'Android' },
  { pluginId: 'app_reviews_ios', idField: 'app_id', platform: 'iOS' },
] as const

const APP_SOURCE_RE = /^(.+)_(android|ios)$/i

/** A config field, trimmed; `''` when the record does not carry it. */
const field = (app: Readonly<Record<string, string>>, key: string): string => (Object.hasOwn(app, key) ? app[key] ?? '' : '').trim()

/** `store id (lower-case) + platform` → the configured app name, for apps whose name differs from the id. */
export function appNamesByStoreId(configs: ReadonlyArray<{ platform: string; idField: string; apps: ReadonlyArray<Record<string, string>> }>): Map<string, string> {
  const names = new Map<string, string>()
  for (const { platform, idField, apps } of configs) {
    for (const app of apps) {
      const storeId = field(app, idField)
      const name = field(app, 'app_name')
      if (storeId !== '' && name !== '' && name !== storeId) names.set(`${storeId.toLowerCase()}|${platform.toLowerCase()}`, name)
    }
  }
  return names
}

/** `com.acme.shop_android` → "Acme Shop (Android)" when known; else undefined. */
export function appSourceName(sourceId: string, names: ReadonlyMap<string, string>): string | undefined {
  const match = APP_SOURCE_RE.exec(sourceId)
  if (match === null) return undefined
  const [, storeId = '', platformId = ''] = match
  const name = names.get(`${storeId.toLowerCase()}|${platformId.toLowerCase()}`)
  const platform = APP_PLUGINS.find((p) => p.platform.toLowerCase() === platformId.toLowerCase())?.platform ?? platformId
  return name === undefined ? undefined : `${name} (${platform})`
}

/** `fallback(sourceId)` unless the source is an app stored under its store id and the app's name is known. */
export function useAppSourceLabel(fallback: (sourceId: string) => string): (sourceId: string) => string {
  const results = useQueries({
    queries: APP_PLUGINS.map(({ pluginId }) => ({
      queryKey: appConfigsKey(pluginId),
      queryFn: () => api.getAppConfigs(pluginId),
      retry: false,
    })),
  })
  const names = appNamesByStoreId(APP_PLUGINS.map(({ platform, idField }, i) => ({
    platform, idField, apps: results[i]?.data?.apps ?? [],
  })))
  return (sourceId) => appSourceName(sourceId, names) ?? fallback(sourceId)
}
