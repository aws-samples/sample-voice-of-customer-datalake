/**
 * @fileoverview Pure model of `@persona`, `@all` and `#document` in the composer (project pages), and `#slug` of a
 * Documents Library item (every page the assistant runs on: docs/documents-library.md).
 *
 * The text holds readable tokens (`@Dana`, `#Delivery plan (v2)`); what is SENT is the list of
 * picks made in the menu, as ids (`forwardedProps.mentions`), never parsed from the text. A pick
 * travels only while its token is still in the text, so deleting the token drops the mention.
 *
 * @module assistant/mentions/mentionModel
 */
import { MENTION_ALL_PERSONAS, MENTION_LIMITS } from '@stream/assistant/contract'
import { DOCUMENT_SECTIONS, byNewestEdit, sectionOf, type DocumentSectionId } from '../../api/documentSections'
import type { Mentions } from '@stream/assistant/contract'

export type MentionKind = 'persona' | 'document'

/** A persona or document the menu can offer (from the project record). */
export interface PersonaSource {
  persona_id: string
  name: string
}

export interface DocumentSource {
  document_id: string
  document_type: string
  /** The project read's list section (api/documentSections.ts); absent = from the type. */
  section?: string
  title: string
  version?: number
  created_at?: string
  /** The last edit: newest first reads it before `created_at` (the Documents tab's own order). */
  updated_at?: string
}

/** A Documents Library item `#` offers (the suggest route's ready items: api/libraryApi.ts). */
export interface LibrarySource {
  item_id: string
  slug: string
  title: string
  /** The extracted text's length, for the composer's "large" hint. */
  extracted_chars?: number
}

/** The menu's groups after the project's sections: the Documents Library (docs/documents-library.md). */
export type MentionSectionId = DocumentSectionId | 'library'

export type MentionOption =
  | { kind: 'all'; key: string; label: string }
  | { kind: 'persona'; key: string; label: string; personaId: string }
  | { kind: 'document'; key: string; label: string; documentId: string; version?: number; section: DocumentSectionId }
  | { kind: 'library'; key: string; label: string; itemId: string; slug: string; chars: number; section: 'library' }

/** A pick made in the menu, with the token it put in the text. */
export type MentionPick = MentionOption & { token: string }

export interface MentionTrigger {
  kind: MentionKind
  /** Index of the `@` / `#` in the text. */
  start: number
  /** What was typed after it, up to the caret. */
  query: string
}

const TRIGGERS: Readonly<Record<string, MentionKind>> = { '@': 'persona', '#': 'document' }
const ALL_TRIGGERS: ReadonlySet<MentionKind> = new Set<MentionKind>(['persona', 'document'])
/** Off a project page: `#` for the library only. */
export const LIBRARY_TRIGGERS: ReadonlySet<MentionKind> = new Set<MentionKind>(['document'])
/** A query longer than this is ordinary text, not a mention being typed. */
const MAX_QUERY_CHARS = 40
/** The DOM id of option `index` of the list `listId` (the textbox's aria-activedescendant). */
export function optionId(listId: string, index: number): string {
  return `${listId}-option-${String(index)}`
}

/** Options shown at once (the list scrolls no further; typing narrows it). */
const MAX_OPTIONS = 8
/** Documents the personas can read (prototype HTML is not text, so it is not offered). */
const NON_TEXT_DOCUMENT_TYPES = new Set(['prototype'])

/**
 * The mention being typed at the caret: an `@` or `#` at the start or after whitespace, followed
 * by no whitespace up to the caret. Null when the caret is not in one, or its kind is not `allowed`
 * (off a project page only `#` mentions anything: the library).
 */
export function findTrigger(text: string, caret: number,
  allowed: ReadonlySet<MentionKind> = ALL_TRIGGERS): MentionTrigger | null {
  const before = text.slice(0, caret)
  const start = Math.max(before.lastIndexOf('@'), before.lastIndexOf('#'))
  if (start < 0) return null
  const found = TRIGGERS[before.charAt(start)]
  const kind = found !== undefined && allowed.has(found) ? found : undefined
  const query = before.slice(start + 1)
  const atBoundary = start === 0 || /\s/.test(before.charAt(start - 1))
  if (kind === undefined || !atBoundary || /\s/.test(query) || query.length > MAX_QUERY_CHARS) return null
  return { kind, start, query }
}

/** "Title (v2)": the version is added when the stored title does not carry it already. */
export function documentLabel({ title, version }: Pick<DocumentSource, 'title' | 'version'>): string {
  const trimmed = title.trim()
  const versioned = version !== undefined && !new RegExp(String.raw`\(v${String(version)}\)$`).test(trimmed)
  return versioned ? `${trimmed} (v${String(version)})` : trimmed
}

function matches(label: string, query: string): boolean {
  return label.toLowerCase().includes(query.toLowerCase())
}

function pickedKeys(picks: readonly MentionPick[]): Set<string> {
  return new Set(picks.map((pick) => pick.key))
}

/** Whether another project document may be picked (the contract bound). */
export function documentsFull(picks: readonly MentionPick[]): boolean {
  return picks.filter((pick) => pick.kind === 'document').length >= MENTION_LIMITS.maxDocuments
}

/** Whether another library item may be picked (the contract bound: 3 a message). */
export function libraryFull(picks: readonly MentionPick[]): boolean {
  return picks.filter((pick) => pick.kind === 'library').length >= MENTION_LIMITS.maxLibraryItems
}

/** Whether nothing more of a trigger's kinds may be picked (`#`: neither a document nor a library item; `@all` counts
 *  as full). `withDocuments` false: off a project page, `#` offers the library alone. */
export function atLimit(kind: MentionKind, picks: readonly MentionPick[], withDocuments = true): boolean {
  if (kind === 'document') return (!withDocuments || documentsFull(picks)) && libraryFull(picks)
  return picks.some((pick) => pick.kind === 'all')
    || picks.filter((pick) => pick.kind === 'persona').length >= MENTION_LIMITS.maxPersonas
}

/** `@all` is offered with two or more personas, before any single persona is picked, while the query fits it. */
function offersAll(personas: readonly PersonaSource[], query: string, picks: readonly MentionPick[]): boolean {
  return personas.length >= 2 && !picks.some((pick) => pick.kind === 'persona') && MENTION_ALL_PERSONAS.startsWith(query.toLowerCase())
}

export function personaMentionOptions(personas: readonly PersonaSource[], query: string, picks: readonly MentionPick[], allLabel: string): MentionOption[] {
  const taken = pickedKeys(picks)
  const all: MentionOption[] = offersAll(personas, query, picks) ? [{ kind: 'all', key: 'all', label: allLabel }] : []
  const each = personas
    .filter((persona) => !taken.has(`persona:${persona.persona_id}`) && matches(persona.name, query))
    .map((persona): MentionOption => ({
      kind: 'persona', key: `persona:${persona.persona_id}`, label: persona.name, personaId: persona.persona_id,
    }))
  return [...all, ...each].slice(0, MAX_OPTIONS)
}

type DocumentOption = Extract<MentionOption, { kind: 'document' }>

/**
 * The most recently edited matching documents (at most MAX_OPTIONS), listed in the project's sections in order
 * (PRD, PR/FAQ, Documents), last edit first within each (`byNewestEdit`, the Documents tab's order); prototypes are left out (their HTML is not text a persona can read).
 */
export function documentMentionOptions(documents: readonly DocumentSource[], query: string, picks: readonly MentionPick[]): MentionOption[] {
  const taken = pickedKeys(picks)
  const newest = documents
    .filter((document) => !NON_TEXT_DOCUMENT_TYPES.has(document.document_type))
    .sort(byNewestEdit)
    .map((document): DocumentOption => ({
      kind: 'document', key: `document:${document.document_id}`, label: documentLabel(document),
      documentId: document.document_id, section: sectionOf(document),
      ...(document.version === undefined ? {} : { version: document.version }),
    }))
    .filter((option) => !taken.has(option.key) && matches(option.label, query))
    .slice(0, MAX_OPTIONS)
  // A stable sort: the same documents as newest-first would offer, grouped, each group still newest first.
  return newest.sort((a, b) => DOCUMENT_SECTIONS.indexOf(a.section) - DOCUMENT_SECTIONS.indexOf(b.section))
}

function sectionOfOption(option: MentionOption | undefined): MentionSectionId | null {
  return option?.kind === 'document' || option?.kind === 'library' ? option.section : null
}

/** The section heading option `index` starts, or null when it continues the one above (or is a persona). */
export function sectionStartingAt(options: readonly MentionOption[], index: number): MentionSectionId | null {
  const section = sectionOfOption(options[index])
  if (section === null) return null
  return sectionOfOption(options[index - 1]) === section ? null : section
}

/**
 * The library items `#` offers (the suggest route's answer for the query, newest first), those not picked yet,
 * at most MAX_OPTIONS, after the project's documents (its own group, "Library").
 */
export function libraryMentionOptions(items: readonly LibrarySource[], query: string, picks: readonly MentionPick[]): MentionOption[] {
  const taken = pickedKeys(picks)
  return items
    .map((item): MentionOption => ({
      kind: 'library', key: `library:${item.item_id}`, label: item.title.trim() || item.slug, itemId: item.item_id,
      slug: item.slug, chars: item.extracted_chars ?? 0, section: 'library',
    }))
    .filter((option) => option.kind === 'library' && !taken.has(option.key)
      && (matches(option.slug, query) || matches(option.label, query)))
    .slice(0, MAX_OPTIONS)
}

/** The token an option puts in the text: a library item's is its slug (`#q3-market`). */
export function tokenOf(option: MentionOption): string {
  if (option.kind === 'all') return `@${MENTION_ALL_PERSONAS}`
  if (option.kind === 'library') return `#${option.slug}`
  return `${option.kind === 'persona' ? '@' : '#'}${option.label}`
}

/** About how many tokens a library item's text is (4 characters a token, the usual rough rule). */
export function approximateTokens(chars: number): number {
  return Math.round(chars / 4)
}

/** Past this many tokens the composer says the item is large (it costs that much input each time it is sent). */
export const LARGE_ITEM_TOKENS = 20_000

/** Replace the typed trigger with the option's token and a space; returns the text and the caret after it. */
export function insertToken(text: string, trigger: MentionTrigger, caret: number, token: string): { text: string; caret: number } {
  const head = `${text.slice(0, trigger.start)}${token} `
  return { text: `${head}${text.slice(caret).replace(/^ /, '')}`, caret: head.length }
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

/** Whether `token` stands in `text` as a whole token (not the start of a longer name). */
function containsToken(text: string, token: string): boolean {
  const escaped = token.replace(REGEX_SPECIAL, String.raw`\$&`)
  return new RegExp(`${escaped}(?![\\p{L}\\p{N}_-])`, 'u').test(text)
}

/** The picks whose token is still in the text (a deleted token drops its mention). */
export function livePicks(picks: readonly MentionPick[], text: string): MentionPick[] {
  return picks.filter((pick) => containsToken(text, pick.token))
}

/** `forwardedProps.mentions` for these picks, or undefined when nothing is mentioned. */
export function mentionsForSend(picks: readonly MentionPick[], text: string): Mentions | undefined {
  const live = livePicks(picks, text)
  const personaIds = live.flatMap((pick) => (pick.kind === 'persona' ? [pick.personaId] : []))
  const documents = live.flatMap((pick) => (pick.kind === 'document'
    ? [{ document_id: pick.documentId, ...(pick.version === undefined ? {} : { version: pick.version }) }]
    : []))
  const library = live.flatMap((pick) => (pick.kind === 'library' ? [{ item_id: pick.itemId }] : []))
  const personas = live.some((pick) => pick.kind === 'all') ? MENTION_ALL_PERSONAS : personaIds.slice(0, MENTION_LIMITS.maxPersonas)
  const mentions: Mentions = {
    ...(personas === MENTION_ALL_PERSONAS || personas.length > 0 ? { personas } : {}),
    ...(documents.length > 0 ? { documents: documents.slice(0, MENTION_LIMITS.maxDocuments) } : {}),
    ...(library.length > 0 ? { library: library.slice(0, MENTION_LIMITS.maxLibraryItems) } : {}),
  }
  return Object.keys(mentions).length === 0 ? undefined : mentions
}
