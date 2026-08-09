/**
 * What the Overview cards know about a project, derived rather than rendered.
 *
 * The Overview tab used to read identically on an empty project and a finished
 * one: five equal-weight launchers, no state. This module answers, for each step,
 * "has it produced anything yet" and "is the input it reads best with missing" —
 * and which step to recommend next.
 *
 * Pure and separate from the component so the interesting cases (empty project,
 * half-finished, done) can be asserted without rendering, and so the ordering
 * rationale lives next to the data that justifies it. It deliberately returns no
 * strings: the component owns the wording, which is also what keeps every i18n
 * key statically visible to the extractor.
 *
 * The step order below is the dependency order, which is NOT the order the cards
 * used to appear in. Personas are built from feedback alone; research can
 * additionally read personas; the document generators can read feedback,
 * personas, research and documents. The old grid put PRD/PR-FAQ *before*
 * research, so a user following it produced documents with neither research nor a
 * deliberate persona selection.
 */
import type {
  ProductContext, ProjectDocument, ProjectPersona,
} from '../../api/types'
import {
  PRODUCT_CONTEXT_FIELD_COUNT, countFilledProductContextFields,
} from './productContextFields'

/** The six Overview steps, in dependency order. */
export type OverviewStep = 'product' | 'personas' | 'research' | 'documents' | 'prototype' | 'remix'

/** Remix needs two documents to combine; below that its card stays disabled. */
export const REMIX_MIN_DOCUMENTS = 2

export interface OverviewStepState {
  /** Position in the sequence, 1-based, as shown on the card. */
  readonly position: number
  /**
   * True once this step has produced something detectable.
   *
   * False on `remix` always, and that is a limitation rather than a fact: a
   * remixed document is stored as an ordinary PRD or PR-FAQ, so there is nothing
   * to distinguish it from a generated one. Nothing recommends remix or reports
   * it as outstanding, so the limitation stays invisible.
   */
  readonly hasOutput: boolean
  /** Product context only: how many of `total` fields carry content. */
  readonly filled?: number
  readonly total?: number
  /** Personas, research and documents: how many exist. */
  readonly count?: number
  /**
   * True when the step's input is missing: research without personas, documents
   * without either, prototype without a PRD or PR-FAQ, remix without two
   * documents to combine.
   *
   * For the three *generators* this is a hint and never a gate — they all work
   * without their optional inputs, just less well. For `prototype` and `remix` it
   * IS a hard block, because neither has anything to operate on: remix has no
   * second document to combine, and the prototype backend reads the latest PRD
   * and/or PR-FAQ, so with neither present there is no source at all. The
   * component decides which reading applies, per card.
   */
  readonly missingUpstream: boolean
}

/**
 * Which of the two prototype source documents exist.
 *
 * `steps.prototype.missingUpstream` answers "can a prototype be built at all",
 * which is all the card needs. This answers "which one is missing", which only the
 * confirm wording needs — derived here rather than recomputed by the component so
 * the two answers cannot drift apart.
 */
export interface PrototypeSources {
  readonly hasPrd: boolean
  readonly hasPrfaq: boolean
}

export interface OverviewState {
  readonly steps: Readonly<Record<OverviewStep, OverviewStepState>>
  /**
   * The step to recommend, or null when everything that can be done has been.
   * The first step with no output, in dependency order — so it only ever points
   * at work whose own inputs are ready.
   */
  readonly nextStep: OverviewStep | null
  readonly prototypeSources: PrototypeSources
}

interface DeriveInput {
  readonly personas: ReadonlyArray<ProjectPersona>
  readonly documents: ReadonlyArray<ProjectDocument>
  /**
   * The project's product context, or undefined while it is still loading or if
   * the request failed. Undefined is deliberately distinct from "all fields
   * blank": a card that cannot know its state should say nothing rather than
   * claim the description is empty.
   */
  readonly productContext?: ProductContext
}

export function deriveOverviewState({
  personas, documents, productContext,
}: DeriveInput): OverviewState {
  const filled = productContext == null ? undefined : countFilledProductContextFields(productContext)
  const researchCount = documents.filter((d) => d.document_type === 'research').length
  const prdCount = documents.filter((d) => d.document_type === 'prd').length
  const prfaqCount = documents.filter((d) => d.document_type === 'prfaq').length
  const prototypeCount = documents.filter((d) => d.document_type === 'prototype').length

  const steps = {
    product: {
      position: 1,
      hasOutput: filled != null && filled > 0,
      filled,
      total: PRODUCT_CONTEXT_FIELD_COUNT,
      missingUpstream: false,
    },
    personas: {
      position: 2,
      hasOutput: personas.length > 0,
      count: personas.length,
      missingUpstream: false,
    },
    research: {
      position: 3,
      hasOutput: researchCount > 0,
      count: researchCount,
      // Research is the one step that can read personas, which is the whole
      // reason personas now come first.
      missingUpstream: personas.length === 0,
    },
    documents: {
      position: 4,
      hasOutput: prdCount + prfaqCount > 0,
      count: prdCount + prfaqCount,
      missingUpstream: personas.length === 0 && researchCount === 0,
    },
    prototype: {
      position: 5,
      // Unlike remix, this one IS detectable: a prototype is stored with its own
      // `document_type`, so the card can report how many exist and the step can be
      // recommended and then stop being recommended.
      hasOutput: prototypeCount > 0,
      count: prototypeCount,
      // A hard block, not a hint. The backend builds from the latest PRD and/or
      // PR-FAQ, so with neither present there is no source — the same condition
      // the control has always enforced, just derived in one place now.
      missingUpstream: prdCount === 0 && prfaqCount === 0,
    },
    remix: {
      position: 6,
      hasOutput: false,
      missingUpstream: documents.length < REMIX_MIN_DOCUMENTS,
    },
  } satisfies Record<OverviewStep, OverviewStepState>

  return {
    steps,
    nextStep: pickNextStep(steps, filled),
    prototypeSources: { hasPrd: prdCount > 0, hasPrfaq: prfaqCount > 0 },
  }
}

/**
 * The first step with no output, in dependency order.
 *
 * Remix is never recommended: it revises existing documents rather than
 * advancing the sequence, so "do this next" would be wrong as often as it was
 * right. Prototype IS recommended, which is the difference between the two even
 * though both are hard-gated — a prototype is a new artifact at the end of the
 * sequence, and unlike a remix it is detectable, so the recommendation clears
 * itself once one exists.
 *
 * Prototype can never be recommended while its own gate is closed, and this is
 * an invariant rather than a coincidence: the gate is "no PRD and no PR-FAQ",
 * which is exactly `documents.hasOutput === false`, and `documents` is earlier in
 * the list — so it is returned first. Keep prototype after documents.
 *
 * While the product context is unknown the recommendation skips step 1 rather
 * than guessing. Telling someone to describe a product they already described is
 * worse than saying nothing, and the state resolves within a render or two.
 */
function pickNextStep(
  steps: Readonly<Record<OverviewStep, OverviewStepState>>,
  filled: number | undefined,
): OverviewStep | null {
  const candidates: ReadonlyArray<OverviewStep> = filled == null
    ? ['personas', 'research', 'documents', 'prototype']
    : ['product', 'personas', 'research', 'documents', 'prototype']
  return candidates.find((step) => !steps[step].hasOutput) ?? null
}
