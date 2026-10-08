/**
 * @fileoverview Company and personal memory (`memory_handler.py`).
 *
 * Company memories are visible to everyone; personal memories only to their
 * owner. Curating company memory (edit, forget, merge, review, imports) is for
 * admins and users carrying the `memory_reviewer` flag — enforced server-side;
 * the SPA learns whether the caller may curate by whether `GET /memory/review`
 * answers (403 → not a curator).
 *
 * Forget is a tombstone + archive (restorable), never a hard delete. Every
 * response is normalized through lenient Zod schemas.
 *
 * @module api/memoryApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { lenientText as text, optionalText, parsedList } from './schemaList'
import { isNonEmptyString, lenientList, toOptionalFiniteNumber } from './lenientFields'
import { asRecord } from './wireRecord'

const MEMORY_SCOPES = ['company', 'personal'] as const
export type MemoryScope = typeof MEMORY_SCOPES[number]

export const MEMORY_STATUSES = ['active', 'proposed', 'conflict', 'archived'] as const
export type MemoryStatus = typeof MEMORY_STATUSES[number]

export const MEMORY_KINDS = ['product', 'customer', 'agents', 'working_style', 'strategy', 'objective', 'other'] as const
export type MemoryKind = typeof MEMORY_KINDS[number]

const SOURCE_KINDS = ['extracted', 'user_explicit', 'import', 'agent'] as const
export type MemorySourceKind = typeof SOURCE_KINDS[number]

export const RETENTIONS = ['long_term', 'dated', 'decay'] as const
export type MemoryRetention = typeof RETENTIONS[number]

export const RESOLVE_ACTIONS = ['keep_both', 'keep', 'replace', 'merge'] as const
export type ResolveAction = typeof RESOLVE_ACTIONS[number]

/** Guards for `<select>` values, so forms narrow without casts. */
export const isMemoryKind = (v: string): v is MemoryKind => MEMORY_KINDS.some((k) => k === v)
export const isMemoryStatus = (v: string): v is MemoryStatus => MEMORY_STATUSES.some((s) => s === v)
export const isMemoryRetention = (v: string): v is MemoryRetention => RETENTIONS.some((r) => r === v)

/** Server limits, mirrored so forms stop the user before a 400. */
export const MAX_STATEMENT_CHARS = 500
export const MAX_IMPORT_CHARS = 200_000

// `.optional()` first: in zod 4 a transform on an ABSENT key otherwise fails the whole row.
const count = z.unknown().optional().transform((v) => Math.max(0, Math.trunc(toOptionalFiniteNumber(v) ?? 0)))
const idList = lenientList(isNonEmptyString)

const MemorySourceSchema = z.object({
  type: z.enum(['session', 'import', 'agent_run']).catch('session'),
  ref: text,
  at: text,
})

const MemoryItemSchema = z.object({
  memory_id: z.string().min(1),
  scope: z.enum(MEMORY_SCOPES).catch('personal'),
  // Unknown status reads as proposed: shown for review, never as settled truth.
  status: z.enum(MEMORY_STATUSES).catch('proposed'),
  kind: z.enum(MEMORY_KINDS).catch('other'),
  statement: text,
  categories: idList,
  confidence: z.unknown().optional().transform((v) => toOptionalFiniteNumber(v)),
  source_kind: z.enum(SOURCE_KINDS).catch('extracted'),
  supporters: count,
  sources: parsedList(MemorySourceSchema),
  created_at: text,
  last_reinforced_at: optionalText,
  retention: z.enum(RETENTIONS).catch('decay'),
  expires_at: optionalText,
  conflicts_with: idList,
  tombstoned: z.boolean().catch(false),
})
export type MemoryItem = z.output<typeof MemoryItemSchema>

const MemoryPageSchema = z.object({
  items: parsedList(MemoryItemSchema),
  next_cursor: optionalText,
}).catch({ items: [] })
export type MemoryPage = z.output<typeof MemoryPageSchema>

const SuggestionSchema = z.object({
  action: z.enum(RESOLVE_ACTIONS),
  winner_id: optionalText,
  statement: optionalText,
  reason: optionalText,
})
type Suggestion = z.output<typeof SuggestionSchema>

/**
 * The server suggests "keep" with a `winner_id` (`memory_policy.suggest_resolution`);
 * when that winner is the OTHER side, the UI's name for it is `replace` ("Keep the
 * existing one"), so the pre-selected radio matches what the reason says.
 */
function suggestionForUi(suggestion: Suggestion | undefined, memoryId: string, conflicts: readonly MemoryItem[]): Suggestion | undefined {
  if (suggestion?.action !== 'keep' || !suggestion.winner_id || suggestion.winner_id === memoryId) return suggestion
  const keepOther: ResolveAction = 'replace'
  return conflicts.some((c) => c.memory_id === suggestion.winner_id) ? { ...suggestion, action: keepOther } : suggestion
}

/**
 * One entry as `memory_handler._review_entry` sends it — `{memory, linked,
 * suggestion}` — read into the UI's `{conflicts, suggested_resolution}`. The
 * older `conflicts` / `suggested_resolution` keys are still accepted.
 */
const ReviewEntrySchema = z.object({
  memory: MemoryItemSchema,
  linked: parsedList(MemoryItemSchema),
  conflicts: parsedList(MemoryItemSchema),
  aligned_objectives: idList,
  suggestion: SuggestionSchema.optional().catch(undefined),
  suggested_resolution: SuggestionSchema.optional().catch(undefined),
}).transform((raw) => {
  const sides = raw.linked.length > 0 ? raw.linked : raw.conflicts
  return {
    memory: raw.memory,
    conflicts: sides,
    aligned_objectives: raw.aligned_objectives,
    suggested_resolution: suggestionForUi(raw.suggestion ?? raw.suggested_resolution, raw.memory.memory_id, sides),
  }
})
export type ReviewEntry = z.output<typeof ReviewEntrySchema>

const ReviewSchema = z.object({ items: parsedList(ReviewEntrySchema) }).catch({ items: [] })

const IMPORT_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const
export type ImportStatus = typeof IMPORT_STATUSES[number]

const ImportRecordSchema = z.object({
  import_id: z.string().min(1),
  title: text,
  url: optionalText,
  status: z.enum(IMPORT_STATUSES).catch('processing'),
  created_at: text,
  memories_created: count,
  error: optionalText,
})
export type ImportRecord = z.output<typeof ImportRecordSchema>

const TERMINAL_IMPORT: ReadonlySet<ImportStatus> = new Set(['completed', 'failed'])
export const isTerminalImport = (record: Pick<ImportRecord, 'status'>) => TERMINAL_IMPORT.has(record.status)

export function normalizeMemoryPage(raw: unknown): MemoryPage {
  return MemoryPageSchema.parse(raw)
}

export function normalizeReview(raw: unknown): ReviewEntry[] {
  return ReviewSchema.parse(raw).items
}

/** An item body, from `{memory}` or the item itself; null when unusable. */
function normalizeMemoryItem(raw: unknown): MemoryItem | null {
  const envelope = z.looseObject({ memory: z.unknown().optional() }).safeParse(raw)
  const parsed = MemoryItemSchema.safeParse(envelope.data?.memory ?? raw)
  return parsed.success ? parsed.data : null
}

function normalizeImport(raw: unknown): ImportRecord | null {
  const envelope = z.looseObject({ import: z.unknown().optional() }).safeParse(raw)
  const parsed = ImportRecordSchema.safeParse(envelope.data?.import ?? raw)
  return parsed.success ? parsed.data : null
}

export interface MemoryListParams {
  scope: MemoryScope
  status?: MemoryStatus
  kind?: MemoryKind
  q?: string
  cursor?: string
}

export function memoryListQuery(params: MemoryListParams): string {
  const search = new URLSearchParams({ scope: params.scope })
  if (params.status) search.set('status', params.status)
  if (params.kind) search.set('kind', params.kind)
  const q = params.q?.trim()
  if (q) search.set('q', q)
  if (params.cursor) search.set('cursor', params.cursor)
  return search.toString()
}

export interface NewMemory {
  scope: MemoryScope
  statement: string
  kind: MemoryKind
  retention?: MemoryRetention
  expires_at?: string
}

export interface ResolveRequest {
  action: ResolveAction
  winner_id?: string
  statement?: string
}

/**
 * The resolve body for a review entry, in `POST /memory/review/{id}/resolve`'s
 * terms. `keep` names the winner: the reviewed item for "Keep this one", the item
 * it conflicts with for the UI's `replace` ("Keep the existing one") — the
 * server's own `replace` action keeps the REVIEWED item (optionally reworded), so
 * sending it here would retire the very memory the user chose to keep. `merge`
 * carries the new text; `keep_both` carries nothing.
 */
export function resolveRequest(
  action: ResolveAction,
  memory: Pick<MemoryItem, 'memory_id'>,
  other: Pick<MemoryItem, 'memory_id'> | undefined,
  statement: string,
): ResolveRequest {
  if (action === 'keep') return { action, winner_id: memory.memory_id }
  if (action === 'replace' && other) return { action: 'keep', winner_id: other.memory_id }
  if (action === 'merge') return { action, statement: statement.trim() }
  return { action }
}

export interface NewImport {
  title: string
  url?: string
  content: string
}

export const memoryKeys = {
  all: () => ['memory'] as const,
  list: (params: Omit<MemoryListParams, 'cursor'>) => ['memory', 'list', params] as const,
  review: () => ['memory', 'review'] as const,
  import: (id: string) => ['memory', 'import', id] as const,
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const item = (id: string, action = '') => `/memory/${encodeURIComponent(id)}${action}`

export const memoryApi = {
  list: async (params: MemoryListParams): Promise<MemoryPage> =>
    normalizeMemoryPage(await fetchApi<unknown>(`/memory?${memoryListQuery(params)}`)),

  add: async (memory: NewMemory): Promise<MemoryItem | null> =>
    normalizeMemoryItem(await fetchApi<unknown>('/memory', post(memory))),

  confirm: async (id: string): Promise<MemoryItem | null> =>
    normalizeMemoryItem(await fetchApi<unknown>(item(id, '/confirm'), post())),

  update: async (id: string, patch: { statement: string; kind?: MemoryKind }): Promise<MemoryItem | null> =>
    normalizeMemoryItem(await fetchApi<unknown>(item(id), { method: 'PUT', body: JSON.stringify(patch) })),

  forget: async (id: string): Promise<MemoryItem | null> =>
    normalizeMemoryItem(await fetchApi<unknown>(item(id, '/forget'), post())),

  restore: async (id: string): Promise<MemoryItem | null> =>
    normalizeMemoryItem(await fetchApi<unknown>(item(id, '/restore'), post())),

  merge: async (ids: readonly string[], statement: string): Promise<MemoryItem | null> =>
    normalizeMemoryItem(await fetchApi<unknown>('/memory/merge', post({ ids, statement }))),

  review: async (): Promise<ReviewEntry[]> => normalizeReview(await fetchApi<unknown>('/memory/review')),

  resolve: async (id: string, request: ResolveRequest): Promise<void> => {
    await fetchApi<unknown>(`/memory/review/${encodeURIComponent(id)}/resolve`, post(request))
  },

  createImport: async (request: NewImport): Promise<ImportRecord | null> => {
    const raw = await fetchApi<unknown>('/memory/imports', post(request))
    // A bare 202 `{import_id}` carries nothing else: what the user submitted
    // fills the gaps, and anything the server did send wins.
    const envelope = z.looseObject({ import: z.unknown().optional() }).safeParse(raw)
    const sent = asRecord(envelope.data?.import ?? raw) ?? {}
    return normalizeImport({ title: request.title, url: request.url, status: 'queued', created_at: new Date().toISOString(), ...sent })
  },

  getImport: async (id: string): Promise<ImportRecord | null> =>
    normalizeImport(await fetchApi<unknown>(`/memory/imports/${encodeURIComponent(id)}`)),
}
