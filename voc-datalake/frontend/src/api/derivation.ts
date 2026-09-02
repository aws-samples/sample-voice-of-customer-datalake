/**
 * @fileoverview The document-derivation contract: "what was this document built
 * from", declared and validated at the query boundary.
 *
 * Every backend path that creates a project document writes a `derivation` map
 * (see lambda/shared/derivation.py): an ordered list of contributing documents,
 * each naming a source document id and the role it played, plus the non-document
 * inputs (how much feedback, which personas, which uploaded visuals, whether
 * the project's product-context block was included). Documents written BEFORE
 * that field existed still explain themselves: `resolveDerivation` reconstructs
 * the same shape from the three lineage shapes that were already on the wire —
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
import { asRecord, displayString } from './wireRecord'

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
  /**
   * Ids of the uploaded IMAGE documents ("visuals") whose extracted descriptions
   * were injected into a prototype's generation prompt.
   *
   * A plain id list, NOT `sources` entries carrying a role, because these ids
   * are NOT resolved to a title or a type and cannot be: a visual is a product
   * document, stored under a different DynamoDB sort key with a
   * `secrets.token_hex(8)` id, so it never appears in the ProjectDocument list
   * `resolveDerivation` resolves sources against. Giving it a role would promise
   * a lookup that can only ever come back unresolved. `persona_ids` is the same
   * shape in the same record for the same reason.
   */
  visual_document_ids: string[]
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
    visual_document_ids: idListSchema,
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
    visual_document_ids: [],
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
    // feedback item count. `visual_document_ids` is deliberately left at the
    // empty default from emptyDerivation(): no legacy shape ever expressed a
    // visual, so a reconstructed derivation has none — there is nothing to read.
    feedback_count: toCount(document.feedback_count),
  }
}

/**
 * True when the derivation can say nothing at all about how the document was
 * built — every recorded input, not just the sources.
 *
 * `selected_document_count` counts even with no sources. "Five selected, none
 * used" is a real record, not an empty one: the generator sets the count before
 * it reads the documents, so a request whose every selected document had since
 * been deleted produces exactly that. Omitting the count here treated such a
 * document as having no derivation, fell through to the legacy path, and
 * reported `origin: 'none'` — so the Documents tab rendered nothing for the one
 * document with the most to explain.
 *
 * `visual_document_ids` counts for the same reason. A prototype grounded in an
 * uploaded screenshot alone records nothing else — no sources, no feedback, no
 * personas — so leaving the visuals out here would send exactly that document to
 * the legacy reconstruction, which cannot express a visual at all, and discard
 * the only input it ever had.
 */
function isEmpty(derivation: DocumentDerivation): boolean {
  return (
    derivation.sources.length === 0 &&
    derivation.selected_document_count === 0 &&
    derivation.feedback_count === 0 &&
    derivation.persona_ids.length === 0 &&
    derivation.visual_document_ids.length === 0 &&
    !derivation.product_context_included
  )
}

/** What a source carries once its document was found. */
export type DerivationSourceFields = Pick<DerivationSource, 'title' | 'document_type'>

/**
 * A project's documents reduced to what resolving a source needs: document_id →
 * the fields a source displays.
 *
 * BUILT ONCE PER PROJECT COLLECTION PASS AND HANDED BACK IN, which is what this
 * type exists to make possible. `resolveDerivation` used to build one of these on
 * every call, which cost nothing while its only callers resolved one document at a
 * time — and became the whole cost the moment a caller asked about a LIST. The
 * prioritization page calls the lineage classifiers per row and each classifier
 * calls the resolver per document on that row, so one project read of D documents
 * was walked once per (row × document) instead of once: measured inside the page's
 * `useMemo` at 200 rows / 1000 documents, 1644 ms in this container's jsdom
 * (562 ms on the reviewing machine — issue #399 B).
 *
 * A LOOKUP TABLE RATHER THAN AN OPAQUE HANDLE, deliberately: everything a source
 * needs is already normalised into it (`displayString`, so an unreadable title or
 * type is '' and never null — `hasSupersededSource` in
 * pages/Prioritization/rowLineage.ts turns on exactly that), and nothing is
 * memoised behind it, so the index's LIFETIME is its holder's and there is no
 * cache anywhere to invalidate. Build it from `derivationSourceIndex` rather than
 * by hand: a map whose values did not come through that builder can carry a null
 * where every reader expects '', which is the one way to make a resolved source
 * indistinguishable from an unresolved one.
 */
export type DerivationSourceIndex = ReadonlyMap<string, DerivationSourceFields>

/**
 * Index the documents a source may resolve against — one pass over the list, for
 * every resolved field at once, so a consumer needs one pass rather than one per
 * field it wants to render.
 */
export function derivationSourceIndex(documents: readonly unknown[]): DerivationSourceIndex {
  const index = new Map<string, DerivationSourceFields>()
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
 *
 * ONE DOCUMENT AT A TIME, and a caller asking about a LIST should reach for
 * `resolveDerivationAgainst` instead: this overload indexes `projectDocuments`
 * afresh on every call, so asking it about N documents of one project walks that
 * project's list N times. Kept exactly as it was because that is the right
 * signature for the callers that hold one document (DocumentsTab), and because
 * every existing caller's behaviour is this function's contract.
 */
export function resolveDerivation(
  document: unknown,
  projectDocuments: readonly unknown[] = [],
): ResolvedDerivation {
  return resolveDerivationAgainst(document, derivationSourceIndex(projectDocuments))
}

/**
 * `resolveDerivation` against an index the caller already built — the same answer,
 * without the per-call pass over the project's documents.
 *
 * THE SAME FUNCTION, not a faster approximation of it: `resolveDerivation` is now
 * this function plus one `derivationSourceIndex` call, so there is no second
 * resolution rule that could drift from the first. `derivation.test.ts` pins the
 * equivalence on a declared, a legacy and an unresolved-source document anyway,
 * because "one function delegates to the other" is a fact about today's source and
 * the promise is about the answers.
 *
 * @param index Built by `derivationSourceIndex` from the project's documents, and
 *   owned by whoever built it — see `DerivationSourceIndex` for why this is
 *   explicit plumbing rather than a memo inside the resolver.
 */
export function resolveDerivationAgainst(
  document: unknown,
  index: DerivationSourceIndex,
): ResolvedDerivation {
  const record = asRecord(document)
  if (!record) return { ...emptyDerivation(), sources: [], origin: 'none' }

  const declared = normalizeDerivation(record.derivation)
  const useDeclared = !isEmpty(declared)
  const derivation = useDeclared ? declared : derivationFromLegacyFields(record)

  return {
    ...derivation,
    origin: originOf(derivation, useDeclared),
    sources: derivation.sources.map((source) => {
      // One lookup decides all three: an unresolved source degrades every
      // resolved field to null together, so a consumer cannot render a type
      // without a title or vice versa.
      const found = index.get(source.document_id)
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
