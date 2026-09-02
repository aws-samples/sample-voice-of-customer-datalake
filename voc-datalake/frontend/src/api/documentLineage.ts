/**
 * @fileoverview Two facts about a project document that are DERIVED rather than
 * stored: which revision of its type it is, and what it revises.
 *
 * Sibling to api/derivation.ts, deliberately not part of it. That module answers
 * "what was this built FROM" (one `derivation` map, written by the backend).
 * These two answer questions the backend does not record at all:
 *
 * - **`ordinalByType`** — contextual creation order for document types that do
 *   not persist a version. PRD/PRFAQ versions are now stored and materialized in
 *   their titles; callers suppress this fallback label when `version` is present.
 * - **`resolveRevision`** — "this prototype revises that one". `revised_from_id`
 *   and `revision_feedback` have been written on every feedback-driven prototype
 *   revision since that feature shipped, arrive on every project read, and until
 *   now were read by nothing.
 *
 * Kept out of derivation.ts because "replaces" is a different relation from
 * "built from": a revision is also built from a PRD, and folding the two would
 * make a prototype look like it was assembled from its own predecessor.
 *
 * Both functions are pure and total — no React, no throwing, and a document
 * whose fields are absent, null or the wrong type reads as "no revision" rather
 * than failing. Same convention as api/derivation.ts and the schemas it cites.
 *
 * @module api/documentLineage
 */
import { asRecord, displayString } from './wireRecord'

/** Where a document sits in the creation order of its own type. */
export interface DocumentOrdinal {
  /** 1-based, oldest first, so the number never changes as newer ones arrive. */
  readonly ordinal: number
  /** How many documents of this type the project has. */
  readonly total: number
}

/** What a document revises, resolved against the project's documents. */
export interface ResolvedRevision {
  readonly revisedFromId: string
  /** Title of the revised document, or null when it was not resolved. */
  readonly title: string | null
  /** False when the revised document is not among those supplied — deleted since. */
  readonly resolved: boolean
  /** The feedback that drove the revision, or '' when none was recorded. */
  readonly feedback: string
}

/**
 * Position of every document within the creation order of its own type.
 *
 * Ordered by `created_at`, breaking ties on `document_id`, which is the same rule
 * the backend uses to pick "the newest of this type" — so the number shown here
 * and the document a default build reads cannot disagree.
 *
 * @param documents The project's documents, in any order. Entries that are not
 *   readable records, or carry no id, are skipped rather than counted: an
 *   unusable entry must not inflate the `total` of a type it cannot belong to.
 * @returns A map from `document_id` to its ordinal. A type with one document
 *   still gets an entry (`1 of 1`); it is the caller's business whether "1 of 1"
 *   is worth rendering.
 */
export function ordinalByType(documents: readonly unknown[]): Map<string, DocumentOrdinal> {
  const byType = new Map<string, NumberableDocument[]>()

  for (const raw of documents) {
    const entry = numberable(raw)
    if (entry === null) continue
    const group = byType.get(entry.type)
    if (group === undefined) byType.set(entry.type, [entry])
    else group.push(entry)
  }

  const ordinals = new Map<string, DocumentOrdinal>()
  for (const group of byType.values()) {
    // Oldest first: a document's ordinal is then a stable fact about it, rather
    // than a position that shifts every time a newer sibling is created.
    const sorted = [...group].sort((a, b) => compareRank(a.rank, b.rank))
    sorted.forEach((entry, index) => {
      ordinals.set(entry.id, { ordinal: index + 1, total: sorted.length })
    })
  }
  return ordinals
}

/** A document reduced to what numbering needs. */
interface NumberableDocument {
  readonly id: string
  readonly type: string
  readonly rank: readonly [string, string]
}

/**
 * One wire document as a numbering entry, or null when it cannot be numbered.
 *
 * Both an id AND a type are required. An entry missing either is skipped rather
 * than defaulted, because the `total` is rendered to the user: a junk record
 * counted in would claim a document that cannot be opened, and grouping every
 * type-less record under '' would make unrelated documents share one sequence and
 * inflate each other's totals.
 */
function numberable(raw: unknown): NumberableDocument | null {
  const record = asRecord(raw)
  if (record === null) return null
  const id = typeof record.document_id === 'string' ? record.document_id : ''
  const type = typeof record.document_type === 'string' ? record.document_type : ''
  if (id === '' || type === '') return null
  const createdAt = typeof record.created_at === 'string' ? record.created_at : ''
  return { id, type, rank: [createdAt, id] }
}

function compareRank(a: readonly [string, string], b: readonly [string, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1
  return 0
}

/**
 * What this document is a revision of, or null when it is not one.
 *
 * Depth-1 by construction: only the immediate predecessor is read, never the
 * predecessor's own. A cyclic pair is therefore inert — each call returns the
 * other document once, and there is no traversal to loop — and a chain of three
 * needs three calls, which is the caller's choice to make rather than a cost
 * imposed here.
 *
 * @param document A project document from the wire. Anything unreadable yields
 *   null rather than an error, so a sparse record cannot break a consumer.
 * @param projectDocuments The project's documents, used only to look up the
 *   revised document's title. A predecessor deleted since comes back with
 *   `resolved: false` and a null title instead of being dropped — the relation
 *   outlives its target, exactly as a derivation source does.
 */
export function resolveRevision(
  document: unknown,
  projectDocuments: readonly unknown[] = [],
): ResolvedRevision | null {
  const record = asRecord(document)
  if (record === null) return null

  // `displayString` collapses the real stored `null` the backend writes for
  // `revised_from_id` into '', so null and absent are one case here.
  const revisedFromId = displayString(record.revised_from_id)
  if (revisedFromId === '') return null

  const baseRecord = findRecord(projectDocuments, revisedFromId)

  return {
    revisedFromId,
    title: baseRecord === null ? null : displayString(baseRecord.title),
    resolved: baseRecord !== null,
    feedback: displayString(record.revision_feedback),
  }
}

/** The supplied document with this id, or null when none of them is readable as it. */
function findRecord(
  documents: readonly unknown[],
  documentId: string,
): Record<string, unknown> | null {
  for (const candidate of documents) {
    const record = asRecord(candidate)
    if (record !== null && record.document_id === documentId) return record
  }
  return null
}
