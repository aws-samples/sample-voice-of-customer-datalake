/**
 * @fileoverview The "New source" menu, grouped by what the person HAS rather
 * than by how the platform reads it: a website link, an app, a file, some
 * pasted text, a tool. The technical options (CSS-selector scrapers, sample
 * data for demos, any unrecognised plugin) sit in a collapsed "Advanced" group.
 *
 * Pure: `buildSourceMenu` turns the deployed plugins and the scraper templates
 * into groups of entries; the selector renders them.
 *
 * @module pages/Scrapers/sourceMenu
 */
import type { ScraperTemplate } from '../../api/types'
import type { PluginManifest } from '../../plugins/types'

export type SourceGroupId = 'website' | 'app' | 'file' | 'paste' | 'tool' | 'advanced'

/** What choosing an entry does. */
type SourceAction =
  | { readonly kind: 'plugin'; readonly plugin: PluginManifest }
  | { readonly kind: 'template'; readonly template: ScraperTemplate }
  | { readonly kind: 'generator'; readonly plugin: PluginManifest }
  | { readonly kind: 'manual' | 'json' | 'csv' }

/** The catalogue keys of an entry's one-line title and description. */
interface EntryKeys {
  readonly title: string
  readonly description: string
}

export interface SourceEntry {
  readonly id: string
  /** Its own words in `scrapers:sourceMenu.items` when the id is known; else the manifest's. */
  readonly keys: EntryKeys | undefined
  readonly fallbackTitle: string
  readonly fallbackDescription: string
  readonly action: SourceAction
  /** Creating it is admin-only (scrapers, every import). */
  readonly adminOnly: boolean
}

export interface SourceGroup {
  readonly id: SourceGroupId
  readonly entries: readonly SourceEntry[]
}

const GROUP_ORDER: readonly SourceGroupId[] = ['website', 'app', 'file', 'paste', 'tool', 'advanced']

/** Plugin id → its group; anything else is Advanced. */
const PLUGIN_GROUPS: Readonly<Record<string, SourceGroupId>> = {
  web_reviews: 'website',
  app_reviews_ios: 'app',
  app_reviews_android: 'app',
  s3_import: 'file',
  github_issues: 'tool',
}

/** Plugins whose configuration is a data import (the S3 import bucket): admin-only like every import. */
const ADMIN_ONLY_PLUGIN_IDS: ReadonlySet<string> = new Set(['s3_import'])

/** Entry ids with their own title + description (literal keys, so the i18n audit sees them). */
const ENTRY_KEYS: Readonly<Record<string, EntryKeys>> = {
  web_reviews: { title: 'sourceMenu.items.webReviews.title', description: 'sourceMenu.items.webReviews.description' },
  template_review_jsonld: { title: 'sourceMenu.items.customScraper.title', description: 'sourceMenu.items.customScraper.description' },
  template_custom_css: { title: 'sourceMenu.items.cssScraper.title', description: 'sourceMenu.items.cssScraper.description' },
  app_reviews_ios: { title: 'sourceMenu.items.ios.title', description: 'sourceMenu.items.ios.description' },
  app_reviews_android: { title: 'sourceMenu.items.android.title', description: 'sourceMenu.items.android.description' },
  csv: { title: 'sourceMenu.items.csv.title', description: 'sourceMenu.items.csv.description' },
  json: { title: 'sourceMenu.items.json.title', description: 'sourceMenu.items.json.description' },
  s3_import: { title: 'sourceMenu.items.s3.title', description: 'sourceMenu.items.s3.description' },
  manual: { title: 'sourceMenu.items.paste.title', description: 'sourceMenu.items.paste.description' },
  github_issues: { title: 'sourceMenu.items.github.title', description: 'sourceMenu.items.github.description' },
  synthetic_reviews: { title: 'sourceMenu.items.synthetic.title', description: 'sourceMenu.items.synthetic.description' },
}

function keysOf(id: string): EntryKeys | undefined {
  return Object.hasOwn(ENTRY_KEYS, id) ? ENTRY_KEYS[id] : undefined
}

function pluginEntry(plugin: PluginManifest): SourceEntry {
  return {
    id: plugin.id, fallbackTitle: plugin.name, fallbackDescription: plugin.description ?? '', keys: keysOf(plugin.id),
    action: { kind: 'plugin', plugin }, adminOnly: ADMIN_ONLY_PLUGIN_IDS.has(plugin.id),
  }
}

function templateEntry(template: ScraperTemplate): SourceEntry {
  const id = `template_${template.id}`
  return {
    id, fallbackTitle: template.name, fallbackDescription: template.description, keys: keysOf(id),
    action: { kind: 'template', template }, adminOnly: true,
  }
}

function generatorEntry(plugin: PluginManifest): SourceEntry {
  return {
    id: plugin.id, fallbackTitle: plugin.name, fallbackDescription: plugin.description ?? '', keys: keysOf(plugin.id),
    action: { kind: 'generator', plugin }, adminOnly: false,
  }
}

function importEntry(kind: 'manual' | 'json' | 'csv'): SourceEntry {
  return { id: kind, fallbackTitle: kind, fallbackDescription: '', keys: keysOf(kind), action: { kind }, adminOnly: true }
}

/** The structured-data template is the plain "custom scraper"; any other template is technical. */
function templateGroup(template: ScraperTemplate): SourceGroupId {
  return template.extraction_method === 'jsonld' ? 'website' : 'advanced'
}

function groupOf(entry: SourceEntry): SourceGroupId {
  const { action } = entry
  if (action.kind === 'plugin') return PLUGIN_GROUPS[action.plugin.id] ?? 'advanced'
  if (action.kind === 'template') return templateGroup(action.template)
  if (action.kind === 'generator') return 'advanced'
  return action.kind === 'manual' ? 'paste' : 'file'
}

/** Within a group, the entries in this order (unlisted ids keep their input order, after these). */
const ENTRY_ORDER: readonly string[] = [
  'web_reviews', 'template_review_jsonld', 'app_reviews_ios', 'app_reviews_android', 'csv', 'json', 's3_import',
]

/** `list` with the ENTRY_ORDER ids first, in that order, then the rest as given. */
function ordered(list: readonly SourceEntry[]): SourceEntry[] {
  const first = ENTRY_ORDER.flatMap((id) => list.filter((entry) => entry.id === id))
  return [...first, ...list.filter((entry) => !ENTRY_ORDER.includes(entry.id))]
}

export function buildSourceMenu(
  plugins: readonly PluginManifest[],
  templates: readonly ScraperTemplate[],
  generators: readonly PluginManifest[],
): SourceGroup[] {
  const entries = [
    ...plugins.map(pluginEntry),
    ...templates.map(templateEntry),
    importEntry('csv'), importEntry('json'), importEntry('manual'),
    ...generators.map(generatorEntry),
  ]
  return GROUP_ORDER
    .map((id) => ({ id, entries: ordered(entries.filter((entry) => groupOf(entry) === id)) }))
    .filter((group) => group.entries.length > 0)
}
