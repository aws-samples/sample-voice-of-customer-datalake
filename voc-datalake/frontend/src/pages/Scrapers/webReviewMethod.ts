/**
 * @fileoverview How a review page (a `web_reviews` target) is read: the managed browser, the default, or Amazon
 * Bedrock's web search index (`method: "bedrock_web_search"`), for sites that block automated browsers. The
 * method is chosen by the source tile a page is added from ("Review page" or "Amazon Bedrock web search index")
 * and kept on the target; the form never shows it as a field.
 *
 * The Bedrock tile is offered only once the deployed `web_reviews` manifest declares the `method` field: until
 * then the API keeps no such key on a target (lambda/shared/web_review_targets.py), so a page added from it would
 * silently be read with the browser.
 * @module pages/Scrapers/webReviewMethod
 */
import { WEB_REVIEWS_PLUGIN_ID, appField } from './scraper-helpers'
import type { AppConfig } from './scraper-helpers'
import type { ConfigField, PluginManifest } from '../../plugins/types'

/** The target's key for how it is read. */
const METHOD_FIELD = 'method'
export const BEDROCK_WEB_SEARCH = 'bedrock_web_search'

type ReviewMethod = 'browser' | typeof BEDROCK_WEB_SEARCH

/** What a page added from the Bedrock tile starts with. */
export const BEDROCK_PRESET: Readonly<AppConfig> = Object.freeze({ [METHOD_FIELD]: BEDROCK_WEB_SEARCH })

/** The settings of a Bedrock web search page only (the model that reads the indexed page): never on a browser page. */
const BEDROCK_ONLY_FIELD_KEYS: ReadonlySet<string> = new Set(['model'])
/** The fields a Bedrock web search page is set up with: its name, its URL, how many reviews a run reads, and its own. */
const BEDROCK_FIELD_KEYS: ReadonlySet<string> = new Set(['app_name', 'url', 'max_reviews', ...BEDROCK_ONLY_FIELD_KEYS])

/** Whether the deployed plugin reads a target's `method` (its manifest declares the field). */
export function offersReviewMethods(plugin: PluginManifest): boolean {
  return plugin.id === WEB_REVIEWS_PLUGIN_ID && plugin.config.some((field) => field.key === METHOD_FIELD)
}

/** How `app` is read: the browser unless it says Bedrock's web search index. */
export function reviewMethod(app: Readonly<AppConfig>): ReviewMethod {
  return appField(app, METHOD_FIELD) === BEDROCK_WEB_SEARCH ? BEDROCK_WEB_SEARCH : 'browser'
}

/** Whether a card shows how its page is read: a review page, once the plugin offers a choice or the page made one. */
export function showsReviewMethod(app: Readonly<AppConfig>, plugin: PluginManifest): boolean {
  return plugin.id === WEB_REVIEWS_PLUGIN_ID && (offersReviewMethods(plugin) || appField(app, METHOD_FIELD) !== '')
}

/**
 * The manifest fields the app form shows for `values`: never the method itself (the tile chose it); for a Bedrock
 * page only its own fields, for a browser page none of the Bedrock-only ones.
 */
export function appFormFields(plugin: PluginManifest, values: Readonly<AppConfig>): ConfigField[] {
  if (plugin.id !== WEB_REVIEWS_PLUGIN_ID) return plugin.config
  const fields = plugin.config.filter((field) => field.key !== METHOD_FIELD)
  if (reviewMethod(values) === BEDROCK_WEB_SEARCH) return fields.filter((field) => BEDROCK_FIELD_KEYS.has(field.key))
  return fields.filter((field) => !BEDROCK_ONLY_FIELD_KEYS.has(field.key))
}
