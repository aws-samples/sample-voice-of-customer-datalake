/**
 * @fileoverview Whether a row's `Crosses generations` label was marked as intentional
 * ("Keep both versions", #399).
 *
 * A row composed ON PURPOSE of two versions of one document type (PRD v1 + PRD v2) is a
 * legitimate thing to score — comparing two drafts side by side — and the label is
 * advisory, but it had no way to be told "yes, on purpose". The API stores that mark on
 * the row record (`lineage_ack`, `lambda/shared/row_lineage_ack.py`) together with the
 * document set it was given for.
 *
 * THE MARK APPLIES ONLY TO THE SET IT NAMES. A row recomposed after the mark keeps the
 * old record, and this module is where that lapses: a set that is not the row's current
 * one reads as not acknowledged, so the warning comes back for a composition nobody
 * looked at. Nothing has to clear the record for that to hold.
 *
 * ONLY A CROSSING CAN BE ACKNOWLEDGED. `coherent` and `absent` are not warnings, so a
 * mark on such a row (a row later narrowed back to one version, say) changes nothing.
 *
 * @module pages/Prioritization/lineageAck
 */
import type { RowLineage } from './rowLineage'

/** The stored mark as the page reads it (`RowSchema.lineage_ack` in `ownRead.ts`). */
export interface RowLineageAck {
  readonly document_ids: readonly string[]
  readonly acknowledged_at: string
}

/** Do the two lists name exactly the same documents, in any order? */
function sameDocumentSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const held = new Set(left)
  return held.size === left.length && right.every((id) => held.has(id))
}

/**
 * Is this row's crossing acknowledged — marked intentional for the documents it holds NOW?
 *
 * `documentIds` is the row's STORED composition (`rows[].document_ids`), not the
 * documents that resolved on screen: the mark was made for the stored set, and a row
 * whose document has since been deleted holds a different set on screen than the one
 * somebody acknowledged.
 */
export function isLineageAcknowledged(
  lineage: Pick<RowLineage, 'state'>,
  ack: RowLineageAck | null | undefined,
  documentIds: readonly string[],
): boolean {
  if (lineage.state !== 'crossGeneration' || !ack) return false
  return sameDocumentSet(ack.document_ids, documentIds)
}

/**
 * The row's lineage with `acknowledged` set when the mark applies, else unchanged.
 *
 * Unchanged rather than `acknowledged: false`, so a row nobody marked carries exactly
 * the value `rowLineageOf` produced and every consumer that never heard of the mark
 * reads the same object it always did.
 */
export function withLineageAck(
  lineage: RowLineage,
  row: { readonly document_ids: readonly string[]; readonly lineage_ack?: RowLineageAck | null },
): RowLineage {
  return isLineageAcknowledged(lineage, row.lineage_ack, row.document_ids)
    ? { ...lineage, acknowledged: true }
    : lineage
}
