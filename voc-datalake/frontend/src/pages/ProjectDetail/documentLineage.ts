/**
 * @fileoverview Which of a document's recorded sources a revision may still send: present, dropped, inherited.
 * @module pages/ProjectDetail/documentLineage
 */

import { resolveDerivation } from '../../api/derivation'
import { MAX_SELECTED_PRODUCT_DOC_IDS, MAX_SELECTED_RESEARCH_IDS } from './overviewState'
import type { ProjectDocument } from '../../api/types'
import type { ProductDoc } from '../../api/projectTypes'

/**
 * A source id to send, or '' when that document is no longer in the project.
 *
 * The API refuses an id it cannot resolve — deliberately, so a build never runs
 * against a document the user did not pick. That makes an INHERITED id a
 * liability: a prototype whose PRD was deleted afterwards would send a dead id on
 * every revision attempt and could never be revised again. Dropping it to '' is
 * the same fallback `usePrototypeBuild.effectiveSourceId` applies to a stale
 * selection, and it is not a silent substitution — the document whose spec would
 * have been preserved does not exist any more.
 */
export function stillPresent(
  documentId: string | null | undefined,
  documents: readonly ProjectDocument[],
): string {
  if (documentId == null || documentId === '') return ''
  return documents.some((d) => d.document_id === documentId) ? documentId : ''
}

/**
 * True when this prototype names a source document that is no longer in the
 * project, so a revision cannot keep the spec it was built from.
 *
 * The fallback is justified — the document is gone — but leaving it unsaid would
 * make it a silent substitution, which is the exact class of behaviour the source
 * picker exists to remove. So the revision panel says it out loud.
 */
export function hasDroppedSource(
  doc: ProjectDocument,
  documents: readonly ProjectDocument[],
): boolean {
  return ([doc.source_prd_id, doc.source_prfaq_id]).some(
    (id) => id != null && id !== '' && stillPresent(id, documents) === '',
  )
}

/** The optional inputs a revision inherits from the prototype it revises. */
export interface InheritedExtraSources {
  readonly useProductContext: boolean
  /**
   * The flag-and-ids pair, in the same shape `usePrototypeBuild` sends: the flag
   * is the switch and the ids are gated on it, so both paths have ONE rule for
   * one API field. Derived here rather than at the send site — a revision has no
   * recorded `use_research` boolean to inherit (the derivation records the reports
   * it used, not the tick-box), so the flag has to come from the ids, and doing
   * that at the call site is what made the two paths differ.
   */
  readonly useResearch: boolean
  readonly researchIds: ReadonlyArray<string>
  /**
   * The visuals the base prototype was grounded in, read straight off its recorded
   * `visual_document_ids`.
   *
   * No flag beside it, unlike the research pair, because the API has none — the
   * list IS the request.
   *
   * Filtered against the project's PRODUCT docs rather than its documents, which is
   * the other difference: a visual is a product doc and never appears in the
   * `ProjectDocument` list, so the filter the reports use would drop every visual
   * instead of only the deleted ones. The filter itself is required for the same
   * reason theirs is — the API answers 404 for a product-doc id it cannot resolve,
   * so one mockup deleted from the Product tab after the build would make this
   * prototype unrevisable, permanently, from the only button that revises it.
   */
  readonly visualIds: ReadonlyArray<string>
}

/**
 * What the base prototype was actually built with, read off its own recorded
 * derivation.
 *
 * Inherited rather than re-derived, and for the same reason the source ids are:
 * re-deriving would ground the revision in whatever exists NOW, so a research
 * report created between the build and the revision would silently join it, or the
 * product-context flag would be lost — a revision that changes its inputs as well
 * as its feedback, which is not what "revise this" means.
 *
 * Read through `resolveDerivation`, which is total: a prototype built before this
 * feature (or one whose derivation is malformed) yields no flag and no reports, so
 * its revision behaves exactly as it does today.
 *
 * Filtered to `document_type === 'research'` — the resolver only knows a type for a
 * source it FOUND among the project's documents, so this drops both a
 * reference-role source that is not research and a report that has since been
 * deleted. Dropping the deleted one is required, not cosmetic: the API rejects an
 * id it cannot resolve, so keeping it would turn someone else's deletion into this
 * revision's 4xx. It is dropped without a note, unlike a dropped PRD — the
 * `feedbackRebased` note says the latest of that type will be used instead, which
 * would be untrue here: nothing substitutes for a missing research report.
 */
export function inheritedExtraSources(
  doc: ProjectDocument,
  documents: readonly ProjectDocument[],
  /**
   * The project's uploaded product docs, or undefined when that list is not known
   * — still loading, or the request failed.
   *
   * Undefined is deliberately NOT the same as an empty list. Empty means the
   * project has no uploads, so an inherited visual is genuinely gone and must be
   * dropped; undefined means nothing was learned, and dropping on that would let a
   * failed side request quietly strip a revision of its entire visual grounding.
   * Unknown therefore sends the ids as recorded and lets the API decide, which is
   * exactly the behaviour before this argument existed.
   */
  productDocs?: readonly ProductDoc[],
): InheritedExtraSources {
  const derivation = resolveDerivation(doc, documents)
  const researchIds = derivation.sources
    .filter((source) => source.role === 'reference' && source.document_type === 'research')
    .map((source) => source.document_id)
    // Sliced to the bound the API enforces, exactly as the build path slices the
    // reports it pre-selects. Today the list cannot exceed it — the API capped the
    // base build that recorded it — so this is a bound on a bound. It earns its
    // line for the day the number is LOWERED: without it every prototype built
    // under the old bound becomes un-revisable, with a 400 naming a list length
    // the user never chose and cannot shorten from this button.
    .slice(0, MAX_SELECTED_RESEARCH_IDS)
  return {
    useProductContext: derivation.product_context_included,
    // The recorded visuals, in the order the base build read them — that order is
    // the model's precedence rule, so preserving it is what makes the revision look
    // like the prototype it revises rather than a re-ranked version of it.
    //
    // Sliced for the same reason as the reports: today the API capped the base
    // build, so this cannot exceed the bound, and the line earns itself the day the
    // bound is LOWERED — without it every prototype built under the old one becomes
    // un-revisable, with a 400 naming a list length the user never chose.
    //
    // Filtered against the PRODUCT docs, not the documents: the API answers 404 for
    // an id it cannot resolve, so a mockup deleted after the build would otherwise
    // make this prototype unrevisable for good.
    //
    // PRESENCE is the test, NOT readiness, and the difference is visible to the
    // user: a visual whose extraction has since FAILED still passes this filter, so
    // the revision sends it, the API accepts it, and the generator then skips it —
    // the revision quietly comes back with less grounding than the prototype it
    // revises. Filtering on `status === 'ready'` instead would not fix that, it
    // would only move the silence one layer earlier; and it would newly drop a
    // visual that is merely mid-re-extraction, which resolves on its own. Saying it
    // belongs with `feedbackRebased` (which already tells the user when an inherited
    // SOURCE was dropped) and is left for that follow-up rather than half-done here.
    visualIds: derivation.visual_document_ids
      .filter((docId) => productDocs == null || productDocs.some((d) => d.doc_id === docId))
      .slice(0, MAX_SELECTED_PRODUCT_DOC_IDS),
    // Inherited research means research: no reports, no flag. Deriving the flag
    // from the ids here — after the filter that drops deleted reports and after
    // the slice — is what keeps it true of the list actually being sent.
    useResearch: researchIds.length > 0,
    researchIds,
  }
}

// ── Succession: what this document replaces ──────────────────────────────────
// A separate section from the derivation footer, and separate on purpose: "this
// revises that" is a different relation from "this was built from that". A
// revision is ALSO built from a PRD, so folding the two would show a prototype as
// though it had been assembled out of its own predecessor.
//
// `revised_from_id` and `revision_feedback` have been written on every
// feedback-driven revision since that feature shipped and have arrived on every
// project read ever since, read by nothing. This is the first consumer.
