/**
 * @fileoverview The ONE place a stored id becomes the label a person reads:
 * category, subcategory, source (source_platform), persona type, keyword.
 *
 * Configured names win (a category's / subcategory's `description`, a source
 * profile's `label`); everything else falls back to a humanised id —
 * underscores → spaces, sentence case, known acronyms and product names
 * spelled their own way (`software_firmware` → `Software firmware`,
 * `api_automation` → `API automation`, `ios` → `iOS`).
 *
 * Source ids get two extra rules, both purely presentational (the stored id
 * is never changed):
 * - app-review connectors store `<app name>_<platform>`; the platform shows
 *   once, in brackets, and not at all when the app name already says it
 *   (`AcmeAir_ios` → `AcmeAir (iOS)`).
 *   An app name that already ends in its platform reads the same way
 *   (`Example Air - iOS_ios` → `Example Air (iOS)`, beside `Example Air_android` → `Example Air (Android)`).
 * - web-review connectors store `web_<site>_<app name>`; they read as
 *   `Acme (Trustpilot)`, and a site that is a hostname as its domain
 *   (`web_www_trustpilot_com` → `trustpilot.com`).
 *
 * Pure functions only; `hooks/useDisplayLabels` binds them to the configured
 * categories and source profiles.
 *
 * @module utils/displayLabels
 */

/** Words that never take sentence case (lowercase key → spelling). */
const SPELLINGS: Readonly<Record<string, string>> = {
  ai: 'AI', api: 'API', apis: 'APIs', b2b: 'B2B', b2c: 'B2C', csat: 'CSAT', csv: 'CSV', faq: 'FAQ',
  faqs: 'FAQs', id: 'ID', ios: 'iOS', ipad: 'iPad', iphone: 'iPhone', json: 'JSON', kpi: 'KPI',
  llm: 'LLM', macos: 'macOS', mcp: 'MCP', nps: 'NPS', os: 'OS', pdf: 'PDF', pii: 'PII', prd: 'PRD',
  qa: 'QA', sdk: 'SDK', seo: 'SEO', sla: 'SLA', sms: 'SMS', sso: 'SSO', tv: 'TV', ui: 'UI', url: 'URL',
  ux: 'UX', cx: 'CX', vpn: 'VPN', android: 'Android', github: 'GitHub', trustpilot: 'Trustpilot',
}

/** The platforms an app-review connector appends to its app name. */
const APP_PLATFORMS: Readonly<Record<string, string>> = { android: 'Android', ios: 'iOS' }

/** A configured name longer than this is an explanation, not a label. */
const MAX_CONFIGURED_LABEL = 60

function spellWord(word: string): string {
  return SPELLINGS[word.toLowerCase()] ?? word
}

function sentenceCase(words: readonly string[]): string {
  const [first = '', ...rest] = words
  // A dotted word is a package / domain name (`com.examplemusic.player`): its case is its spelling.
  const raised = first.includes('.') ? first : first.charAt(0).toUpperCase() + first.slice(1)
  const head = SPELLINGS[first.toLowerCase()] ?? raised
  return [head, ...rest].join(' ')
}

/**
 * A stored id as a label: `existing_customer` → `Existing customer`,
 * `ease of_use` → `Ease of use`, `tac_services` → `Tac services`.
 * Words keep their own casing (`AcmeAir` stays `AcmeAir`); only the first
 * letter is raised. Empty in, empty out.
 */
export function humanizeId(id: string): string {
  const words = id.replace(/_/g, ' ').split(' ').filter(Boolean).map(spellWord)
  return sentenceCase(words)
}

/** A configured name when it reads as a label (non-empty, one line, short). */
function usableName(name: string | undefined): string | undefined {
  const trimmed = name?.trim() ?? ''
  return trimmed === '' || trimmed.length > MAX_CONFIGURED_LABEL || trimmed.includes('\n') ? undefined : trimmed
}

/** The (sub)category shape these helpers read — the settings config rows. */
interface LabelledEntry {
  readonly name: string
  readonly description?: string
}

interface LabelledCategory extends LabelledEntry {
  readonly subcategories?: readonly LabelledEntry[]
}

/** The id every review outside the configured categories is counted under (backend `shared/other_category.py`). */
export const OTHER_CATEGORY = 'other'

/** The enrichment's placeholder for "the model could not tell" (`shared/categorization.py`). */
const UNKNOWN_JOURNEY_STAGE = 'unknown'

/**
 * A journey stage worth a label chip, or undefined. `unknown` is the model's
 * "could not tell": a chip reading "Unknown" beside the category read as the
 * subcategory (5.34.00), while the category editor rightly said "None".
 */
export function knownJourneyStage(stage: string | null | undefined): string | undefined {
  return stage === null || stage === undefined || stage === '' || stage.toLowerCase() === UNKNOWN_JOURNEY_STAGE ? undefined : stage
}

/**
 * A category id's label: its configured name, else the humanised id. `other`
 * (not configured) reads as `otherLabel` — the translated "Other" — when given.
 */
export function categoryLabel(id: string, categories: readonly LabelledCategory[] = [], otherLabel?: string): string {
  const configured = categories.find((c) => c.name === id)
  const fallback = id === OTHER_CATEGORY && otherLabel !== undefined ? otherLabel : humanizeId(id)
  return usableName(configured?.description) ?? fallback
}

/**
 * A trending keyword's label. A keyword that IS a category id
 * (`pricing_licensing`) reads as that category does (`Pricing & Licensing`),
 * so the word cloud and the category chips agree; any other keyword is shown
 * as written.
 */
export function keywordLabel(keyword: string, categories: readonly LabelledCategory[] = []): string {
  return categories.some((c) => c.name === keyword) ? categoryLabel(keyword, categories) : keyword
}

/**
 * A subcategory id's label. Looks under `parent` first (ids may repeat across
 * categories), then anywhere; else the humanised id.
 */
export function subcategoryLabel(
  id: string,
  parent: string | undefined,
  categories: readonly LabelledCategory[] = [],
): string {
  const inParent = categories.find((c) => c.name === parent)?.subcategories?.find((s) => s.name === id)
  const anywhere = inParent ?? categories.flatMap((c) => c.subcategories ?? []).find((s) => s.name === id)
  return usableName(anywhere?.description) ?? humanizeId(id)
}

/** `Category / Subcategory`, or just the category when there is none. */
export function themeLabel(
  category: string,
  subcategory: string | null | undefined,
  categories: readonly LabelledCategory[] = [],
): string {
  const head = categoryLabel(category, categories)
  return subcategory === null || subcategory === undefined || subcategory === ''
    ? head
    : `${head} / ${subcategoryLabel(subcategory, category, categories)}`
}

/** The source-profile shape these helpers read. */
interface LabelledSource {
  readonly id: string
  readonly label: string
  /** A Radar source's brand (another company's reviews, docs/radar.md). */
  readonly radar_brand?: string
}

/** Source ids a Radar connector or import is stored under (`radar_<brand>`). */
const RADAR_SOURCE_RE = /^radar_(.+)$/

/**
 * A Radar source as "Radar · <Brand>": from its profile's brand, else from a
 * `radar_<brand>` id; undefined for an ordinary source. (`radar_example_air` read as
 * "Radar example air" in the import, policy and erasure pickers.)
 */
function radarSourceLabel(id: string, profile: LabelledSource | undefined): string | undefined {
  const brand = profile?.radar_brand?.trim() ?? ''
  if (brand !== '') return `Radar · ${humanizeId(brand)}`
  const match = RADAR_SOURCE_RE.exec(id)
  return match === null ? undefined : `Radar · ${humanizeId(match[1] ?? '')}`
}

/** Characters that join an app name to a platform it spells out (`Example Air - iOS`, `Acme_android`, `Example Air (iOS)`). */
const PLATFORM_JOINERS = new Set(['-', '_', '('])

/**
 * `app` without a trailing `platformId` it already spells out after a joiner
 * (`Example Air - iOS` → `Example Air`, `Acme Android` → `Acme`), else undefined. A
 * platform that is part of a word (`Biosphere`) is not a suffix.
 */
function withoutPlatformSuffix(app: string, platformId: string): string | undefined {
  const trimmed = app.trim()
  const closed = trimmed.endsWith(')') ? trimmed.slice(0, -1).trimEnd() : trimmed
  if (!closed.toLowerCase().endsWith(platformId.toLowerCase())) return undefined
  const head = closed.slice(0, closed.length - platformId.length)
  const spaced = head.trimEnd()
  const joined = PLATFORM_JOINERS.has(spaced.slice(-1)) ? spaced.slice(0, -1).trimEnd() : spaced
  const separated = joined.length < head.length
  return separated && joined !== '' ? joined : undefined
}

/**
 * `<app name>_<platform>` → `App name (Platform)`; undefined when not an app
 * connector. An app name that already ends in its platform (`Example Air - iOS`,
 * `Acme Android`) reads the same as one that does not (`Example Air (iOS)`); one
 * that names it mid-name keeps the name alone.
 */
function appConnectorLabel(id: string): string | undefined {
  const match = /^(.+)_(android|ios)$/i.exec(id)
  if (match === null) return undefined
  const [, app = '', platformId = ''] = match
  const platform = APP_PLATFORMS[platformId.toLowerCase()] ?? platformId
  const base = withoutPlatformSuffix(app, platformId)
  if (base !== undefined) return `${humanizeId(base)} (${platform})`
  const name = humanizeId(app)
  const saysPlatform = new RegExp(`(^|[^a-z])${platformId}([^a-z]|$)`, 'i').test(app)
  return saysPlatform ? name : `${name} (${platform})`
}

/** Host prefixes a slugged hostname starts with (`www_trustpilot_com`). */
const HOST_PREFIXES = new Set(['www', 'm'])
/** Top-level domains a slugged hostname ends its domain part with (`trustpilot_com`, `example_co_uk`). */
const TOP_LEVEL_DOMAINS = new Set([
  'com', 'net', 'org', 'io', 'app', 'dev', 'info', 'biz', 'uk', 'de', 'fr', 'es', 'it', 'nl', 'be', 'ch',
  'at', 'se', 'no', 'dk', 'fi', 'pl', 'pt', 'ie', 'br', 'mx', 'ar', 'cl', 'au', 'nz', 'ca', 'jp', 'in',
])

/**
 * The slugged hostname at the start of `parts` (`[www, trustpilot, com, …]`):
 * the domain (`trustpilot.com`) and what follows it, or undefined when the
 * parts do not start with one. `co` only counts before a country (`co_uk`).
 */
function leadingDomain(parts: readonly string[]): { domain: string; rest: readonly string[] } | undefined {
  const labels = HOST_PREFIXES.has(parts[0] ?? '') ? parts.slice(1) : parts
  const isTld = (part: string | undefined, i: number) =>
    part !== undefined && (TOP_LEVEL_DOMAINS.has(part) || (part === 'co' && TOP_LEVEL_DOMAINS.has(labels[i + 1] ?? '')))
  if (labels.length < 2 || !isTld(labels[1], 1)) return undefined
  const tldCount = labels.slice(1).findIndex((part, i) => !isTld(part, i + 1))
  const end = tldCount === -1 ? labels.length : tldCount + 1
  return { domain: labels.slice(0, end).join('.'), rest: labels.slice(end) }
}

/**
 * `web_<site>_<app name>` → `App name (Site)`; undefined when not a web-review
 * connector. A site part that is a hostname reads as the site's NAME, like every other
 * source label (`web_www_trustpilot_com` → `Trustpilot`, `web_www_trustpilot_com_acme` →
 * `Acme (Trustpilot)`, the same as `web_trustpilot_acme`), never a bare `trustpilot.com`.
 */
function webConnectorLabel(id: string): string | undefined {
  const match = /^web_([a-z0-9-]+)_(.+)$/.exec(id)
  if (match === null) return undefined
  const [, site = '', app = ''] = match
  const host = leadingDomain([site, ...app.split('_').filter(Boolean)])
  if (host === undefined) return `${humanizeId(app)} (${humanizeId(site)})`
  const siteName = humanizeId(host.domain.split('.')[0] ?? host.domain)
  return host.rest.length === 0 ? siteName : `${humanizeId(host.rest.join('_'))} (${siteName})`
}

/**
 * The platform's own sources (not connectors an admin names), whose names the SPA
 * translates (`common:builtInSources.<id>`): a humanised id stayed English in every
 * language ("Feedback form" in Spanish, 5.34.00). `email_intake`'s English entry is the
 * label the API gives its unconfigured profile (`shared/source_profiles.py`).
 */
export const BUILT_IN_SOURCES: Readonly<Record<string, string>> = {
  webscraper: 'Web scraper',
  manual_import: 'Manual import',
  s3_import: 'S3 import',
  feedback_form: 'Feedback form',
  prototype_feedback: 'Prototype feedback',
  github_issues: 'GitHub Issues',
  app_reviews_ios: 'iOS App Reviews',
  app_reviews_android: 'Android App Reviews',
  synthetic_reviews: 'Synthetic reviews',
  web_reviews: 'Web reviews',
  email_intake: 'Email inbox',
}

/** A built-in source's name in the reader's language, else undefined. */
export type BuiltInSourceName = (id: string) => string | undefined

/**
 * A source id's label: its source profile's label (when an admin set one — a
 * profile without one carries its id, a built-in one its English default), then a
 * built-in source's translated name, else the connector-aware humanised id.
 */
export function sourceLabel(id: string, profiles: readonly LabelledSource[] = [], builtIn?: BuiltInSourceName): string {
  const profile = profiles.find((p) => p.id === id)
  const englishDefault = Object.hasOwn(BUILT_IN_SOURCES, id) ? BUILT_IN_SOURCES[id] : undefined
  const label = adminLabel(profile, englishDefault)
  if (label !== undefined) return label
  const builtInName = englishDefault === undefined ? undefined : builtIn?.(id) ?? englishDefault
  return builtInName ?? connectorLabel(id, profile)
}

/** The label an admin set on a profile: not blank, not its id, not the built-in English default. */
function adminLabel(profile: LabelledSource | undefined, englishDefault: string | undefined): string | undefined {
  const label = profile?.label.trim() ?? ''
  return label === '' || label === profile?.id || label === englishDefault ? undefined : label
}

/** The connector-aware humanised id (Radar, app and web-review connectors, else the id). */
function connectorLabel(id: string, profile: LabelledSource | undefined): string {
  return radarSourceLabel(id, profile) ?? appConnectorLabel(id) ?? webConnectorLabel(id) ?? humanizeId(id)
}

/** Channels that only name the connector kind — the source label already says it. */
const CONNECTOR_CHANNEL_RE = /^(app_review_[a-z]+|web_scrape(_[a-z]+)?|unknown)$/

/**
 * A `source_channel` worth showing beside its source, or undefined when it
 * repeats the source or only names the connector kind (`app_review_android`,
 * `web_scrape_jsonld`).
 */
export function channelLabel(channel: string | undefined, sourceId: string): string | undefined {
  const trimmed = channel?.trim() ?? ''
  if (trimmed === '' || trimmed === sourceId || CONNECTOR_CHANNEL_RE.test(trimmed)) return undefined
  return humanizeId(trimmed)
}
