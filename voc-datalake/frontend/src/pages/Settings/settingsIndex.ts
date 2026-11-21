/**
 * @fileoverview What Administration's search looks in (7.54.00's search, 7.59.00's tabs; SettingsSearch.tsx): every
 * tab, every section and every card a link may name (adminTabs.ts), plus the settings that live elsewhere (Agents ›
 * Spend, Account › Preferences), each with its address and the words someone might type for it: its title, its tab,
 * and its terms (`settings:search.terms.<id>`, the field labels and synonyms of that place in the reader's language,
 * so "invite", "GDPR", "quota" or "theme" find the place that holds them). A tab with sections has no terms of its
 * own: its sections carry them.
 *
 * The matching is plain and predictable: every word of the query must appear in the entry's words (case and accents
 * ignored); a title that starts with the query ranks first, then a title that contains it, then a term that is it,
 * then a term that starts with it, then the rest, each in the index's own order (the tabs').
 *
 * @module pages/Settings/settingsIndex
 */
import { agentsPath } from '../Agents/agentsPaths'
import { accountTabPath } from '../Account/accountSections'
import { adminPath } from './adminPaths'
import { cardsOf, hasSections, sectionOfCard, visibleSections, visibleTabs } from './adminTabs'
import type { AdminCardId, AdminSectionId, AdminTabId, AdminViewer } from './adminTabs'
import { cardLabelKey, sectionLabelKey, tabLabelKey } from './adminTabLabels'

/** One place the search can open. */
interface SettingsEntry {
  /** Unique: the tab, `<tab>/<section>`, `<tab>#<card>`, or `elsewhere/<place>`. */
  readonly id: string
  /** `settings:` keys of its title, of the tab it is on (null: a tab, its own place), and of its terms (null: none). */
  readonly titleKey: string
  readonly placeKey: string | null
  readonly termsKey: string | null
  readonly path: string
}

/** Each place's terms key (`settings:search.terms.*`), spelled out so the i18n audit sees every key. */
const TAB_TERMS: Readonly<Partial<Record<AdminTabId, string>>> = {
  general: 'search.terms.general', ai: 'search.terms.ai', agents: 'search.terms.agents',
}

const SECTION_TERMS: Readonly<Record<AdminSectionId, string>> = {
  plugins: 'search.terms.plugins', integrations: 'search.terms.integrations', inbox: 'search.terms.inbox',
  radar: 'search.terms.radar', categories: 'search.terms.categories', dimensions: 'search.terms.dimensions',
  policies: 'search.terms.policies', users: 'search.terms.users', boards: 'search.terms.boards',
  settings: 'search.terms.workspace', members: 'search.terms.members', all: 'search.terms.allWorkspaces',
  'deployment-brand': 'search.terms.deploymentBrand', logs: 'search.terms.logs', version: 'search.terms.version',
}

const CARD_TERMS: Readonly<Record<AdminCardId, string>> = {
  brand: 'search.terms.brand', theme: 'search.terms.theme', 'app-feedback': 'search.terms.appFeedback', api: 'search.terms.api',
  erasure: 'search.terms.erasure',
  domains: 'search.terms.domains', participants: 'search.terms.participants', 'hard-cap': 'search.terms.hardCap',
  models: 'search.terms.models', connections: 'search.terms.connections',
}

function tabEntries(tab: AdminTabId, viewer: AdminViewer): SettingsEntry[] {
  const sections = visibleSections(tab, viewer)
  const first = hasSections(tab) ? sections[0] ?? null : null
  const own: SettingsEntry = { id: tab, titleKey: tabLabelKey(tab), placeKey: null, termsKey: TAB_TERMS[tab] ?? null, path: adminPath({ tab, section: first }) }
  const place = tabLabelKey(tab)
  const sectionEntries = sections.map((section): SettingsEntry => ({
    id: `${tab}/${section}`, titleKey: sectionLabelKey(section), placeKey: place, termsKey: SECTION_TERMS[section],
    path: adminPath({ tab, section }),
  }))
  const cards = (hasSections(tab) ? sections.flatMap((section) => cardsOf(tab, section)) : cardsOf(tab, null))
    // (the API endpoint is a development build's alone: GeneralTab.tsx)
    .filter((card) => card !== 'api' || import.meta.env.DEV)
  const cardEntries = cards.map((card): SettingsEntry => ({
    id: `${tab}#${card}`, titleKey: cardLabelKey(card), placeKey: place, termsKey: CARD_TERMS[card],
    path: adminPath({ tab, section: sectionOfCard(tab, card), card }),
  }))
  return [own, ...sectionEntries, ...cardEntries]
}

/** What lives outside Administration but an administrator looks for in it. */
const ELSEWHERE: readonly (SettingsEntry & { readonly needsAgents: boolean })[] = [
  { id: 'elsewhere/spend', titleKey: 'search.titles.spend', placeKey: 'search.places.agents', termsKey: 'search.terms.spend', path: agentsPath({ view: 'spend' }), needsAgents: true },
  { id: 'elsewhere/preferences', titleKey: 'search.titles.preferences', placeKey: 'search.places.account', termsKey: 'search.terms.preferences', path: accountTabPath('preferences'), needsAgents: false },
]

/**
 * Every place this viewer may open: the tabs, sections and cards they may see, and the places elsewhere (Agents ›
 * Spend only while the engineering agents are shown).
 */
export function settingsIndex(viewer: AdminViewer): SettingsEntry[] {
  const admin = visibleTabs(viewer).flatMap((tab) => tabEntries(tab, viewer))
  const elsewhere = ELSEWHERE.filter((entry) => viewer.agentsShown || !entry.needsAgents)
    .map(({ needsAgents: _needsAgents, ...entry }) => entry)
  return [...admin, ...elsewhere]
}

/** An entry with its words in the reader's language. */
export interface ResolvedEntry {
  readonly entry: SettingsEntry
  readonly title: string
  /** The tab it is on (null: a tab). */
  readonly place: string | null
  /** Its terms, comma-separated in the locale ('' for none). */
  readonly terms: string
}

/** Lower case, no accents: "Données" and "donnees" match. */
function foldText(text: string): string {
  return text.toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

/** Lower is better; null: no match. */
function rank(resolved: ResolvedEntry, query: string, words: readonly string[]): number | null {
  const title = foldText(resolved.title)
  const terms = foldText(resolved.terms).split(',').map((term) => term.trim()).filter((term) => term !== '')
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
