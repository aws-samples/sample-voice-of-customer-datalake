/**
 * @fileoverview What Administration's search looks in (7.54.00, SettingsSearch.tsx): every tab and every section (a
 * card a path names) of adminTabs.ts, plus the settings that live elsewhere (Agents › Spend and Connections, Account ›
 * Preferences), each with its path and the words someone might type for it: its title, its tab, and its terms
 * (`settings:search.terms.<id>`, the field labels and synonyms of that place in the reader's language, so "invite",
 * "GDPR", "quota" or "theme" find the place that holds them).
 *
 * The matching is plain and predictable: every word of the query must appear in the entry's words (case and accents
 * ignored); a title that starts with the query ranks first, then a title that contains it, then a term that is it,
 * then a term that starts with it, then the rest, each in the index's own order (the navigation's).
 *
 * @module pages/Settings/settingsIndex
 */
import { agentsPath } from '../Agents/agentsPaths'
import { accountTabPath } from '../Account/accountSections'
import { adminPath } from './adminPaths'
import { ADMIN_GROUPS, isVisibleTab, visibleSections } from './adminTabs'
import type { AdminSectionId, AdminTabId } from './adminTabs'
import { sectionLabelKey, tabLabelKey } from './adminTabLabels'

/** One place the search can open. */
interface SettingsEntry {
  /** Unique: the tab, `<tab>/<section>`, or `elsewhere/<place>`. */
  readonly id: string
  /** `settings:` keys of its title, of the page it is on (null: a tab, which is its own page), and of its terms. */
  readonly titleKey: string
  readonly placeKey: string | null
  readonly termsKey: string
  readonly path: string
}

/** Each place's terms key (`settings:search.terms.*`), spelled out so the i18n audit sees every key. */
const TERMS_KEYS: Readonly<Record<AdminTabId | AdminSectionId | 'connections' | 'spend' | 'preferences', string>> = {
  people: 'search.terms.people', sources: 'search.terms.sources', logs: 'search.terms.logs',
  categories: 'search.terms.categories', boards: 'search.terms.boards', ai: 'search.terms.ai', brand: 'search.terms.brand',
  privacy: 'search.terms.privacy', platform: 'search.terms.platform', version: 'search.terms.version',
  inbox: 'search.terms.inbox', radar: 'search.terms.radar', tokens: 'search.terms.tokens',
  dimensions: 'search.terms.dimensions', domains: 'search.terms.domains', participants: 'search.terms.participants',
  theme: 'search.terms.theme', erasure: 'search.terms.erasure', 'deployment-brand': 'search.terms.deploymentBrand',
  connections: 'search.terms.connections', spend: 'search.terms.spend', preferences: 'search.terms.preferences',
}
const termsKeyOf = (id: keyof typeof TERMS_KEYS): string => TERMS_KEYS[id]

function tabEntry(tab: AdminTabId): SettingsEntry {
  return { id: tab, titleKey: tabLabelKey(tab), placeKey: null, termsKey: termsKeyOf(tab), path: adminPath({ tab, section: null }) }
}

function sectionEntry(tab: AdminTabId, section: AdminSectionId): SettingsEntry {
  return {
    id: `${tab}/${section}`, titleKey: sectionLabelKey(section), placeKey: tabLabelKey(tab), termsKey: termsKeyOf(section),
    path: adminPath({ tab, section }),
  }
}

/** The tabs in the navigation's order, then Version (the home's footer). */
const ORDERED_TABS: readonly AdminTabId[] = [...ADMIN_GROUPS.flatMap((group) => group.tabs), 'version']

/** What lives outside Administration but an administrator looks for in it. */
const ELSEWHERE: readonly (SettingsEntry & { readonly needsAgents: boolean })[] = [
  { id: 'elsewhere/connections', titleKey: 'search.titles.connections', placeKey: 'search.places.agents', termsKey: termsKeyOf('connections'), path: agentsPath({ view: 'connections' }), needsAgents: true },
  { id: 'elsewhere/spend', titleKey: 'search.titles.spend', placeKey: 'search.places.agents', termsKey: termsKeyOf('spend'), path: agentsPath({ view: 'spend' }), needsAgents: true },
  { id: 'elsewhere/preferences', titleKey: 'search.titles.preferences', placeKey: 'search.places.account', termsKey: termsKeyOf('preferences'), path: accountTabPath('preferences'), needsAgents: false },
]

/**
 * Every place this caller may open: the tabs and sections they may see, and the places elsewhere (the Agents ones
 * only when the Agents page is in the menu).
 */
export function settingsIndex(isAdmin: boolean, isPlatformAdmin: boolean, agentsShown: boolean): SettingsEntry[] {
  const admin = ORDERED_TABS.filter((tab) => isVisibleTab(tab, isAdmin, isPlatformAdmin)).flatMap((tab) => [
    tabEntry(tab),
    ...visibleSections(tab, isAdmin, isPlatformAdmin).map((section) => sectionEntry(tab, section)),
  ])
  const elsewhere = ELSEWHERE.filter((entry) => agentsShown || !entry.needsAgents)
    .map(({ needsAgents: _needsAgents, ...entry }) => entry)
  return [...admin, ...elsewhere]
}

/** An entry with its words in the reader's language. */
export interface ResolvedEntry {
  readonly entry: SettingsEntry
  readonly title: string
  /** The page it is on (null: a tab). */
  readonly place: string | null
  /** Its terms, comma-separated in the locale. */
  readonly terms: string
}

/** Lower case, no accents: "Données" and "donnees" match. */
function foldText(text: string): string {
  return text.toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

/** Lower is better; null: no match. */
function rank(resolved: ResolvedEntry, query: string, words: readonly string[]): number | null {
  const title = foldText(resolved.title)
  const terms = foldText(resolved.terms).split(',').map((term) => term.trim())
  const haystack = [title, foldText(resolved.place ?? ''), ...terms].join(' ')
  if (!words.every((word) => haystack.includes(word))) return null
  if (title.startsWith(query)) return 0
  if (title.includes(query)) return 1
  if (terms.includes(query)) return 2
  return terms.some((term) => term.startsWith(query)) ? 3 : 4
}

/** The most results the list shows. */
const MAX_RESULTS = 8

/** The entries that match `query`, best first (see the module's doc); none for an empty query. */
export function searchSettings(entries: readonly ResolvedEntry[], query: string): ResolvedEntry[] {
  const folded = foldText(query).trim()
  const words = folded.split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return []
  return entries
    .map((resolved, index) => ({ resolved, index, score: rank(resolved, folded, words) }))
    .filter((scored): scored is { resolved: ResolvedEntry; index: number; score: number } => scored.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, MAX_RESULTS)
    .map((scored) => scored.resolved)
}
