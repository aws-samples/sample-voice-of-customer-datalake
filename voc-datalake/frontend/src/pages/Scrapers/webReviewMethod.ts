/**
 * @fileoverview How a review page (a `web_reviews` target) is read, its `method`
 * (lambda/shared/web_review_targets.py, docs/web-reviews.md → Methods):
 *
 * - `auto` (Automatic, the default, also for a page saved before `method` existed): the signed browser, then the
 *   Amazon Bedrock web index, then AgentCore web search snippets (excerpts); each workspace learns which works per
 *   site (docs/web-reviews.md → Learning which method works);
 * - `browser` (Browser only): the managed browser, page by page;
 * - `bedrock_web_search` (Bedrock web index only): the page's copy in Amazon Bedrock's web index, one page per run.
 *
 * The review page form shows the choice as "Read with" (ReviewMethodSelect.tsx); the "Amazon Bedrock web search
 * index" tile presets Bedrock web index only. Both are offered only once the deployed `web_reviews` manifest declares
 * the `method` field: until then the API keeps no such key on a target, so a choice would silently be dropped.
 * @module pages/Scrapers/webReviewMethod
 */
import { WEB_REVIEWS_PLUGIN_ID, appField } from './scraper-helpers'
import type { AppConfig } from './scraper-helpers'
import type { ConfigField, PluginManifest } from '../../plugins/types'

/** The target's key for how it is read. */
export const METHOD_FIELD = 'method'
export const AUTO_METHOD = 'auto'
const BROWSER_METHOD = 'browser'
export const BEDROCK_WEB_SEARCH = 'bedrock_web_search'

/** Every method a target may name, in the order the form offers them. */
const REVIEW_METHODS = [AUTO_METHOD, BROWSER_METHOD, BEDROCK_WEB_SEARCH] as const
export type ReviewMethod = typeof REVIEW_METHODS[number]

/** What a page added from the Bedrock tile starts with. */
export const BEDROCK_PRESET: Readonly<AppConfig> = Object.freeze({ [METHOD_FIELD]: BEDROCK_WEB_SEARCH })

/**
 * The fields a Bedrock web search page is set up with: its name, its URL and how many reviews a run reads. The
 * model that reads it is no page's: it is chosen in Administration → AI models ("Review pages: Bedrock web search").
 */
const BEDROCK_FIELD_KEYS: ReadonlySet<string> = new Set(['app_name', 'url', 'max_reviews'])

function isReviewMethod(value: string): value is ReviewMethod {
  return REVIEW_METHODS.some((method) => method === value)
}

/** Whether the deployed plugin reads a target's `method` (its manifest declares the field). */
export function offersReviewMethods(plugin: PluginManifest): boolean {
  return plugin.id === WEB_REVIEWS_PLUGIN_ID && plugin.config.some((field) => field.key === METHOD_FIELD)
}

/** How `app` is read: its stored method when it is one, else Automatic (the server's default). */
export function reviewMethod(app: Readonly<AppConfig>): ReviewMethod {
  const stored = appField(app, METHOD_FIELD)
  return isReviewMethod(stored) ? stored : AUTO_METHOD
}

/** The methods the deployed manifest offers, in its order (the form offers no other). */
export function offeredReviewMethods(plugin: PluginManifest): ReviewMethod[] {
  const field = plugin.config.find((entry) => entry.key === METHOD_FIELD)
  return (field?.options ?? []).map((option) => option.value).filter(isReviewMethod)
}

/** Whether a card shows how its page is read: a review page, once the plugin offers a choice or the page made one. */
export function showsReviewMethod(app: Readonly<AppConfig>, plugin: PluginManifest): boolean {
  return plugin.id === WEB_REVIEWS_PLUGIN_ID && (offersReviewMethods(plugin) || appField(app, METHOD_FIELD) !== '')
}

/**
 * The manifest fields the app form shows for `values`: never the method itself (ReviewMethodSelect shows it, with
 * its labels in the UI language); for a Bedrock page only its own fields.
 */
export function appFormFields(plugin: PluginManifest, values: Readonly<AppConfig>): ConfigField[] {
  if (plugin.id !== WEB_REVIEWS_PLUGIN_ID) return plugin.config
  const fields = plugin.config.filter((field) => field.key !== METHOD_FIELD)
  if (reviewMethod(values) === BEDROCK_WEB_SEARCH) return fields.filter((field) => BEDROCK_FIELD_KEYS.has(field.key))
  return fields
}

/**
 * The site a review page's URL is on, as the learned methods are keyed (lambda/shared/web_review_methods.py
 * `site_domain`): its host, lower-cased, without `www.`; undefined when the URL does not parse.
 */
export function reviewPageDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return undefined
  }
}
