/**
 * @fileoverview The document-derivation contract: "what was this document built
 * from", declared and validated at the query boundary.
 *
 * Every backend path that creates a project document writes a `derivation` map
 * (see lambda/shared/derivation.py): an ordered list of contributing documents,
 * each naming a source document id and the role it played, plus the non-document
 * inputs (how much feedback, which personas, whether the project's
 * product-context block was included). Documents written BEFORE that field
 * existed still explain themselves: `resolveDerivation` reconstructs the same
 * shape from the three lineage shapes that were already on the wire —
 * `source_prd_id`/`source_prfaq_id` on a prototype, `source_documents` on a
 * merge output, and `feedback_count` on a research report — none of which was
 * declared anywhere in the frontend until now.
 *
 * Everything here is lenient on purpose, following the repository's
 * schema-at-the-query-boundary convention (api/feedbackSchema.ts,
 * api/scrapersSchema.ts, pages/FeedbackForms/formSchema.ts — the last of those
 * exists because a sparse record blanked a whole route). Absent, null, an empty
 * list and a malformed entry all read as "no lineage", and only the lineage is
 * validated: a document is never rejected because its provenance is unreadable.
 *
 * `resolveDerivation` is pure and total — it renders nothing, imports no React,
 * never throws, and always returns one entry per readable source.
 *
 * @module api/derivation
 */
import { z } from 'zod'

/**
 * The closed role vocabulary, in the order a resolved derivation reports it.
 *
 * Derived from what the backend actually does, and kept in lockstep with
 * lambda/shared/derivation.py by
 * lambda/shared/test/test_derivation_roles_lockstep.py. Adding a role here is a
 * compile error in every place that maps one (see LEGACY_SOURCE_BY_ROLE below).
 */
export const DERIVATION_ROLES = [
  /** A reference document the request selected and the generator fed the model. */
  'reference',
  /** The PRD a prototype was built from. */
  'prototype_prd',
  /** The PR/FAQ a prototype was built from. */
  'prototype_prfaq',
  /** A document fed to a merge. */
  'merge_input',
] as const

export type DerivationRole = (typeof DERIVATION_ROLES)[number]

/**
 * Where a resolved derivation came from. `'none'` means no lineage was
 * recoverable — a legitimate answer for a hand-authored document, never an
 * error.
 */
export type DerivationOrigin = 'declared' | 'legacy' | 'none'

/** One contributing document, resolved against the project's documents. */
export interface DerivationSource {
  document_id: string
  role: DerivationRole
  /** Title of the source document, or null when it was not resolved. */
  title: string | null
  /**
   * Type of the source document ('prd', 'prototype', …), or null when it was
   * not resolved — degrading exactly as `title` does, from the same lookup, so a
   * consumer that renders a type badge beside a title gets both from one pass.
   *
   * NOT interchangeable with `role`: `role` says how the document contributed
   * ('merge_input'), `document_type` says what it is ('prd'). Left as a plain
   * string rather than the ProjectDocument union because it is whatever the wire
   * supplied, and a newer backend may name a type this bundle has never heard of.
   */
  document_type: string | null
  /**
   * False when the source document was not among the documents supplied to the
   * resolver — either because it has since been deleted, or because no
   * documents were supplied to resolve against.
   */
  resolved: boolean
}

/** The stored shape, as written by lambda/shared/derivation.py. */
export interface DocumentDerivation {
  sources: Array<{ document_id: string; role: DerivationRole }>
  /**
   * How many reference documents the request selected. Can EXCEED
   * `sources.length`: the generator feeds the model at most the first three, so
   * the difference is the silent drop, recorded rather than implied.
   */
  selected_document_count: number
  feedback_count: number
  persona_ids: string[]
  product_context_included: boolean
}

/** A derivation resolved for display: sources plus the non-document inputs. */
export interface ResolvedDerivation extends Omit<DocumentDerivation, 'sources'> {
  sources: DerivationSource[]
  origin: DerivationOrigin
}

/** Coerce DynamoDB/JSON number round-trips ("3", 3.0) to a count, else 0. */
function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Keep non-empty string items, drop junk instead of discarding the array. */
const idListSchema = z
  .array(z.unknown())
  .catch(() => [])
  .transform((items) => items.filter((item): item is string => typeof item === 'string' && item !== ''))

/**
 * One `sources` entry. Neither field can be salvaged when absent: an entry with
 * no document id points at nothing, and a role outside the closed vocabulary
 * cannot be named (it means a newer backend than this bundle). Such entries are
 * dropped by `sourceListSchema` rather than defaulted, so one malformed entry
 * costs exactly itself.
 */
const sourceSchema = z.object({
  document_id: z.string().min(1),
  role: z.enum(DERIVATION_ROLES),
})

const sourceListSchema = z
  .array(z.unknown())
  .catch(() => [])
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = sourceSchema.safeParse(item)
      return parsed.success ? [parsed.data] : []
    }),
  )

/**
 * The stored derivation. Object-level catch makes a non-object — including the
 * real stored `null` some backends write in place of an omitted key — degrade to
 * an empty derivation, so null and absent are indistinguishable to every
 * consumer.
 */
export const DocumentDerivationSchema = z
  .object({
    sources: sourceListSchema,
    selected_document_count: z.preprocess(toCount, z.number()),
    feedback_count: z.preprocess(toCount, z.number()),
    persona_ids: idListSchema,
    product_context_included: z.boolean().catch(false),
  })
  .catch(() => emptyDerivation())

/** A derivation that records nothing. */
export function emptyDerivation(): DocumentDerivation {
  return {
    sources: [],
    selected_document_count: 0,
    feedback_count: 0,
    persona_ids: [],
    product_context_included: false,
  }
}

/**
 * Make the declared derivation contract true for one wire value. Total: any
 * input, including null/undefined/a string, yields a usable derivation.
 */
export function normalizeDerivation(raw: unknown): DocumentDerivation {
  return DocumentDerivationSchema.parse(raw ?? {})
}

/**
 * The pre-`derivation` field that carries each role, keyed by role so that
 * adding a role to DERIVATION_ROLES is a compile error here. `null` means no
 * legacy shape ever expressed that role — plain reference documents were never
 * recorded at all, which is the gap this contract closes.
 */
const LEGACY_SOURCE_BY_ROLE = {
  reference: null,
  prototype_prd: { field: 'source_prd_id', arity: 'one' },
  prototype_prfaq: { field: 'source_prfaq_id', arity: 'one' },
  merge_input: { field: 'source_documents', arity: 'many' },
} as const satisfies Record<DerivationRole, { field: string; arity: 'one' | 'many' } | null>

/**
 * A wire value as a readable bag of fields, or null when it is not one.
 * Parsed rather than asserted (repo convention: no `as`), which also rejects the
 * array and primitive shapes an API can deliver in place of a document.
 */
const recordSchema = z.record(z.string(), z.unknown())

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = recordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Reconstruct a derivation from the lineage shapes that predate this contract. */
function derivationFromLegacyFields(document: Record<string, unknown>): DocumentDerivation {
  const sources: DocumentDerivation['sources'] = []
  for (const role of DERIVATION_ROLES) {
    const legacy = LEGACY_SOURCE_BY_ROLE[role]
    if (legacy === null) continue
    const raw = document[legacy.field]
    // A legacy prototype stores `source_prd_id: null` (a REAL stored null, from
    // `(prd or {}).get('document_id')`) when it was built from a PR/FAQ alone.
    // Reading null exactly like an absent key is what keeps such a prototype
    // from claiming a source it never had.
    const ids = legacy.arity === 'many' ? idListSchema.parse(raw) : idListSchema.parse([raw])
    for (const id of ids) sources.push({ document_id: id, role })
  }
  return {
    ...emptyDerivation(),
    sources,
    // Legacy records cannot distinguish used from requested — a merge stored the
    // ids it was ASKED for — so the two numbers are reported as equal rather
    // than inventing a drop that may not have happened.
    selected_document_count: sources.length,
    // The one non-document input any legacy shape recorded: a research report's
    // feedback item count.
    feedback_count: toCount(document.feedback_count),
  }
}

function isEmpty(derivation: DocumentDerivation): boolean {
  return (
    derivation.sources.length === 0 &&
    derivation.feedback_count === 0 &&
    derivation.persona_ids.length === 0 &&
    !derivation.product_context_included
  )
}

/** What a source carries once its document was found. */
type ResolvedSourceFields = Pick<DerivationSource, 'title' | 'document_type'>

/** A displayable string, or '' for a field the wire did not supply as one. */
function displayString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Index of document_id → the fields a source displays, over whatever the caller
 * supplied. One index for every resolved field, so a consumer needs one pass
 * over the document list rather than one per field it wants to render.
 */
function sourceFieldIndex(documents: readonly unknown[]): Map<string, ResolvedSourceFields> {
  const index = new Map<string, ResolvedSourceFields>()
  for (const raw of documents) {
    const record = asRecord(raw)
    if (!record) continue
    const id = record.document_id
    if (typeof id !== 'string' || id === '') continue
    index.set(id, {
      title: displayString(record.title),
      document_type: displayString(record.document_type),
    })
  }
  return index
}

/**
 * Answer "what was this document built from" for any document, new or legacy.
 *
 * Reads the declared `derivation` first and falls back to the pre-existing
 * lineage fields, so the result is indistinguishable in form either way. A
 * document with nothing recoverable reports `origin: 'none'` and empty inputs.
 *
 * @param document A project document from the wire. Anything unreadable —
 *   null, a string, a document whose derivation is malformed — yields an empty
 *   result rather than an error, so no consumer can be broken by a sparse
 *   record and no surrounding document is ever rejected.
 * @param projectDocuments The project's documents, used only to look up what
 *   each source is — its title and its document type. A source that is not among
 *   them (deleted since, or none supplied) comes back with `resolved: false` and
 *   both fields null instead of being dropped — the relation survives its target.
 *
 * Depth-1 by construction: only the document's own direct sources are read,
 * never a source's sources. A cyclic chain (A built from B, B built from A) is
 * therefore inert — each call returns the other document, once, and there is no
 * traversal to loop.
 */
export function resolveDerivation(
  document: unknown,
  projectDocuments: readonly unknown[] = [],
): ResolvedDerivation {
  const record = asRecord(document)
  if (!record) return { ...emptyDerivation(), sources: [], origin: 'none' }

  const declared = normalizeDerivation(record.derivation)
  const useDeclared = !isEmpty(declared)
  const derivation = useDeclared ? declared : derivationFromLegacyFields(record)

  const fields = sourceFieldIndex(projectDocuments)
  return {
    ...derivation,
    origin: originOf(derivation, useDeclared),
    sources: derivation.sources.map((source) => {
      // One lookup decides all three: an unresolved source degrades every
      // resolved field to null together, so a consumer cannot render a type
      // without a title or vice versa.
      const found = fields.get(source.document_id)
      return {
        document_id: source.document_id,
        role: source.role,
        title: found?.title ?? null,
        document_type: found?.document_type ?? null,
        resolved: found !== undefined,
      }
    }),
  }
}

/** Nothing recoverable reads as 'none' wherever it was read from, so
 * `origin === 'none'` is exactly "this document cannot say what it was built
 * from" — including a declared-but-empty record. */
function originOf(derivation: DocumentDerivation, fromDeclaredField: boolean): DerivationOrigin {
  if (isEmpty(derivation)) return 'none'
  return fromDeclaredField ? 'declared' : 'legacy'
}
