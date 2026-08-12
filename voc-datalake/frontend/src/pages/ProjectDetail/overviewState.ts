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

/**
 * How many research reports one prototype build may name.
 *
 * The same number as `MAX_SELECTED_RESEARCH_IDS` in
 * `lambda/api/projects_handler.py`, which enforces it — each id costs one keyed
 * read there, so an unbounded list turns one request into N of them. Kept in
 * lockstep by `lambda/api/test/test_research_selection_bound_lockstep.py`: a UI
 * that lets a user pick more than the API accepts fails on submit, after the
 * choice was made and with nothing said about which report to give up.
 *
 * That test reads THIS LINE as source text, matching `^export const
 * MAX_SELECTED_RESEARCH_IDS = <digits>` — it does not import the module, so that
 * it needs neither a bundler nor the Python import graph. So the declaration has
 * to stay one line starting at column 0 with a bare integer literal: fold it into
 * an object, compute it, or add a second assignment, and the test fails loudly
 * (it asserts exactly one match) rather than passing vacuously. Changing the
 * shape here means updating the regex there.
 *
 * Here rather than beside the request type in `projectsApi.ts` for a mundane
 * reason worth writing down: that module is mocked with explicit partial objects
 * by a dozen test files, so a new named export on it makes every one of them
 * throw. This module is where the option lists are derived and is mocked nowhere.
 */
export const MAX_SELECTED_RESEARCH_IDS = 10

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

/** One document a prototype build could be aimed at. */
export interface PrototypeSourceOption {
  readonly document_id: string
  readonly title: string
  readonly created_at: string
}

/**
 * Which of the two prototype source documents exist, and which specific ones the
 * build could read.
 *
 * `steps.prototype.missingUpstream` answers "can a prototype be built at all",
 * which is all the card needs. This answers "which one is missing", which the
 * confirm wording needs, and "which are the candidates", which the source picker
 * needs — all derived here rather than recomputed by the component so they cannot
 * drift apart.
 *
 * Both lists are NEWEST FIRST, so `[0]` is the default the backend would pick on
 * its own. That ordering is load-bearing rather than cosmetic: the picker's
 * default selection and the backend's latest-of-type must name the same document,
 * or the dialog would state one thing and the build do another.
 */
export interface PrototypeSources {
  readonly hasPrd: boolean
  readonly hasPrfaq: boolean
  readonly prdOptions: ReadonlyArray<PrototypeSourceOption>
  readonly prfaqOptions: ReadonlyArray<PrototypeSourceOption>
  /**
   * The research reports the build can additionally be told to read, newest
   * first — the optional third input, alongside the two required ones.
   *
   * A separate list rather than entries in a combined document selection: the
   * shared reference-document path keeps only the first three of a selection and
   * research sorts last, so a general picker drops exactly what this list exists
   * to offer. Kept distinct here for the same reason `DataSourceSteps` keeps
   * `selectedResearchIds` apart from `selectedDocumentIds`.
   */
  readonly researchOptions: ReadonlyArray<PrototypeSourceOption>
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
  const researchOptions = sourceOptions(documents, 'research')
  const researchCount = researchOptions.length
  const prdOptions = sourceOptions(documents, 'prd')
  const prfaqOptions = sourceOptions(documents, 'prfaq')
  const prdCount = prdOptions.length
  const prfaqCount = prfaqOptions.length
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
    prototypeSources: {
      hasPrd: prdCount > 0,
      hasPrfaq: prfaqCount > 0,
      prdOptions,
      prfaqOptions,
      researchOptions,
    },
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

/**
 * The documents of one type a prototype build could be aimed at, newest first.
 *
 * The sort mirrors the backend's newest-of-type rule exactly — `created_at`
 * descending, ties broken on `document_id` descending — and that agreement is the
 * whole point. The picker offers `[0]` as its default and the request then names
 * it explicitly, so if the two orderings disagreed the dialog would state one
 * document and the build read another, which is the defect this feature exists to
 * remove rather than relocate.
 *
 * A tie is not hypothetical: the live project this was built against has four
 * prototypes sharing one date, because ids carry a whole-second timestamp.
 */
function sourceOptions(
  documents: ReadonlyArray<ProjectDocument>,
  documentType: 'prd' | 'prfaq' | 'research',
): ReadonlyArray<PrototypeSourceOption> {
  return documents
    .filter((d) => d.document_type === documentType)
    .map((d) => ({ document_id: d.document_id, title: d.title, created_at: d.created_at }))
    .sort((a, b) => (
      a.created_at === b.created_at
        ? compareDescending(a.document_id, b.document_id)
        : compareDescending(a.created_at, b.created_at)
    ))
}

function compareDescending(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? 1 : -1
}
