/**
 * @fileoverview Pure model of `@persona`, `@all` and `#document` in the composer (project pages).
 *
 * The text holds readable tokens (`@Dana`, `#Delivery plan (v2)`); what is SENT is the list of
 * picks made in the menu, as ids (`forwardedProps.mentions`), never parsed from the text. A pick
 * travels only while its token is still in the text, so deleting the token drops the mention.
 *
 * @module assistant/mentions/mentionModel
 */
import { MENTION_ALL_PERSONAS, MENTION_LIMITS } from '../contract'
import type { Mentions } from '../contract'

export type MentionKind = 'persona' | 'document'

/** A persona or document the menu can offer (from the project record). */
export interface PersonaSource {
  persona_id: string
  name: string
}

export interface DocumentSource {
  document_id: string
  document_type: string
  title: string
  version?: number
  created_at?: string
}

export type MentionOption =
  | { kind: 'all'; key: string; label: string }
  | { kind: 'persona'; key: string; label: string; personaId: string }
  | { kind: 'document'; key: string; label: string; documentId: string; version?: number }

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
 * by no whitespace up to the caret. Null when the caret is not in one.
 */
export function findTrigger(text: string, caret: number): MentionTrigger | null {
  const before = text.slice(0, caret)
  const start = Math.max(before.lastIndexOf('@'), before.lastIndexOf('#'))
  if (start < 0) return null
  const kind = TRIGGERS[before.charAt(start)]
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

/** Whether another persona / document may be picked (the contract bounds, `@all` counts as full). */
export function atLimit(kind: MentionKind, picks: readonly MentionPick[]): boolean {
  if (kind === 'document') return picks.filter((pick) => pick.kind === 'document').length >= MENTION_LIMITS.maxDocuments
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

/** Newest first; prototypes are left out (their HTML is not text a persona can read). */
export function documentMentionOptions(documents: readonly DocumentSource[], query: string, picks: readonly MentionPick[]): MentionOption[] {
  const taken = pickedKeys(picks)
  return documents
    .filter((document) => !NON_TEXT_DOCUMENT_TYPES.has(document.document_type))
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .map((document): MentionOption => ({
      kind: 'document', key: `document:${document.document_id}`, label: documentLabel(document),
      documentId: document.document_id,
      ...(document.version === undefined ? {} : { version: document.version }),
    }))
    .filter((option) => !taken.has(option.key) && matches(option.label, query))
    .slice(0, MAX_OPTIONS)
}

/** The token an option puts in the text. */
export function tokenOf(option: MentionOption): string {
  if (option.kind === 'all') return `@${MENTION_ALL_PERSONAS}`
  return `${option.kind === 'persona' ? '@' : '#'}${option.label}`
}

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
  const personas = live.some((pick) => pick.kind === 'all') ? MENTION_ALL_PERSONAS : personaIds.slice(0, MENTION_LIMITS.maxPersonas)
  const mentions: Mentions = {
    ...(personas === MENTION_ALL_PERSONAS || personas.length > 0 ? { personas } : {}),
    ...(documents.length > 0 ? { documents: documents.slice(0, MENTION_LIMITS.maxDocuments) } : {}),
  }
  return mentions.personas === undefined && mentions.documents === undefined ? undefined : mentions
}
