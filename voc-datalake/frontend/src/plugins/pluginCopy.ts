/**
 * @fileoverview The translated name and description of a data-source plugin.
 *
 * `manifests.json` is generated from each plugin's `manifest.json`, which is English
 * (5.35.03, e2e 5.35.02: in Spanish, Administration → Sources still read "Android App
 * Reviews … Collect customer reviews from the Google Play Store"). The copy shown in the
 * app comes from the locale files instead, keyed by plugin id; the manifest's own text is
 * the fallback for a plugin added without keys (pluginCopy.test.tsx fails for one).
 *
 * @module plugins/pluginCopy
 */
import { useTranslation } from 'react-i18next'
import type { PluginManifest } from './types'

interface PluginCopyKeys {
  nameKey: string
  descriptionKey: string
}

/** Literal namespace-qualified keys, so the i18n audit sees every one of them. */
const PLUGIN_COPY_KEYS: Readonly<Record<string, PluginCopyKeys>> = {
  app_reviews_android: { nameKey: 'settings:pluginCopy.appReviewsAndroid.name', descriptionKey: 'settings:pluginCopy.appReviewsAndroid.description' },
  app_reviews_ios: { nameKey: 'settings:pluginCopy.appReviewsIos.name', descriptionKey: 'settings:pluginCopy.appReviewsIos.description' },
  github_issues: { nameKey: 'settings:pluginCopy.githubIssues.name', descriptionKey: 'settings:pluginCopy.githubIssues.description' },
  s3_import: { nameKey: 'settings:pluginCopy.s3Import.name', descriptionKey: 'settings:pluginCopy.s3Import.description' },
  synthetic_reviews: { nameKey: 'settings:pluginCopy.syntheticReviews.name', descriptionKey: 'settings:pluginCopy.syntheticReviews.description' },
  web_reviews: { nameKey: 'settings:pluginCopy.webReviews.name', descriptionKey: 'settings:pluginCopy.webReviews.description' },
  webscraper: { nameKey: 'settings:pluginCopy.webscraper.name', descriptionKey: 'settings:pluginCopy.webscraper.description' },
}

/** The locale keys of a plugin's copy, or undefined for a plugin without any. */
export function pluginCopyKeys(pluginId: string): PluginCopyKeys | undefined {
  return Object.hasOwn(PLUGIN_COPY_KEYS, pluginId) ? PLUGIN_COPY_KEYS[pluginId] : undefined
}

export interface PluginCopy {
  name: string
  description: string | undefined
}

type PluginCopyFields = Pick<PluginManifest, 'id' | 'name' | 'description'>

/** `(plugin) => { name, description }` in the UI language. */
export function usePluginCopy(): (plugin: PluginCopyFields) => PluginCopy {
  const { t } = useTranslation('settings')
  return (plugin) => {
    const keys = pluginCopyKeys(plugin.id)
    if (keys === undefined) return { name: plugin.name, description: plugin.description }
    return { name: t(keys.nameKey), description: t(keys.descriptionKey) }
  }
}
