/**
 * @fileoverview Shared utilities for the prioritization feature.
 * @module pages/Prioritization/prioritizationUtils
 */

import type { RowLineage } from './rowLineage'
import type {
  ProjectDocument, PrioritizationScore, PrioritizationBallotEdit, WireBallotEdit,
} from '../../api/types'

/**
 * ONE ROW OF THIS PAGE: a project, and the documents that row is scored on.
 *
 * The row used to be a DOCUMENT — every scorable document of every project became
 * its own row — so a project whose PRD and PR/FAQ describe one idea appeared twice
 * and a reviewer scored the same idea twice. On real data that was roughly one
 * proposal in three, and once a room votes from their phones the QR on one of those
 * two rows scored half the idea.
 *
 * `row_id` is what everything on this page is keyed by: the caller's own ballot,
 * the team aggregate, the sort position, the expansion, and the ballot a room
 * casts. `documents` are the row's own documents RESOLVED against the project read
 * — concrete ids on the row, matched to the documents on screen — and each stays
 * individually visible inside the expansion with its own collected form evidence.
 *
 * `title` and `created_at` describe the row for the list: they come from the
 * leading document (see `collectRows`), because a row has no title of its own and
 * a reviewer scanning the list is looking for the proposal's name.
 */
export interface PrioritizationRowView {
  readonly row_id: string
  readonly project_id: string
  readonly project_name: string
  /** The row's documents, newest first, as resolved against the project read. */
  readonly documents: readonly ProjectDocument[]
  /** What the list calls this row — the leading document's title. */
  readonly title: string
  /** When the leading document was created; the date sort reads this. */
  readonly created_at: string
  /**
   * Has a ballot landed, so the composition can no longer change?
   *
   * Carried from the row record through the same Zod boundary every other field
   * crosses (`RowSchema`, which degrades an unreadable value to FALSE for the reason
   * recorded there). A fact the row DISPLAYS and never enforces: the freeze is a
   * condition on the write itself, so a composition change racing the first ballot
   * answers 409 whatever this said a moment earlier — which is why the page has to be
   * able to state that refusal as well as withhold the control.
   */
  readonly is_frozen: boolean
  /**
   * Is this the row the default-row ensure minted for the project, rather than one a
   * reviewer composed?
   *
   * Carried through the same `RowSchema` boundary as `is_frozen`, and degrading to
   * FALSE for the same kind of reason: the one thing the page does with this is
   * WITHHOLD the delete control for a project's only default row, which the API
   * refuses with 409 ("a project's default row cannot be deleted while it is the
   * project's only row"), and an unreadable value should leave the control offered and
   * let the server answer rather than hide an action that may well be legal.
   */
  readonly is_default: boolean
  /**
   * What the row's documents say about EACH OTHER: one derivation chain, a
   * combination crossing generations, or no lineage recorded — and, for a frozen
   * row, whether a fresher combination of the same document types exists that does
   * not itself cross generations. See `rowLineage`.
   *
   * ON THE VIEW rather than derived in the component, for the reason the team
   * view is resolved once before the sort: the derivation resolver runs per
   * document per row, and this page re-renders on every slider drag. Resolved
   * where the row's documents and the project's are both already in hand
   * (`collectRows`), so nothing can look the documents up a second time and
   * disagree with the first — and the source index those lookups go through is
   * built there ONCE per project read rather than per call (see
   * `ProjectLineageSources`, issue #399 B, for the measurement).
   *
   * DESCRIBES, NEVER GATES. Every state is scorable and keeps every composition
   * control it would otherwise have; the only thing this decides is what the row
   * SAYS. See the `rowLineage` module docstring.
   */
  readonly lineage: RowLineage
  /**
   * Did a stored `document_id` fail to resolve against the project read? Then the
   * documents on screen are not the set the row holds, and "Keep both versions" cannot
   * be given for them (the API compares the stored set and would answer 409 to every
   * press), so `RowLineageAckControl` says why instead of offering the button.
   * Optional, defaulting to "no", for views built without a stored id list behind them.
   */
  readonly composition_truncated?: boolean
  /**
   * May the caller edit this row's project (`Project.access.can_edit`)? Gates the
   * "Keep both versions" control, which the API refuses a viewer with 403. Optional,
   * and absent reads as "no" (fail closed: it can only hide a control).
   */
  readonly can_edit?: boolean
  // The row's prototype (if any), resolved the same way. Surfaced under the
  // document preview so reviewers can see the demo without leaving the page.
  readonly prototype?: ProjectDocument
}

/**
 * What the list can be ordered by: the team composite, any ACTIVE metric of the scoring
 * setup (`axis:<id>` — ids are configured, so the field is too), or a document field.
 */
export type AxisSortField = `axis:${string}`
export type SortField = 'priority_score' | 'created_at' | 'title' | AxisSortField
export type SortDirection = 'asc' | 'desc'

export const axisSortField = (axisId: string): AxisSortField => `axis:${axisId}`

/** The axis id an `axis:<id>` sort field orders by, or `null` for every other field. */
export const sortAxisId = (field: SortField): string | null => (
  field.startsWith('axis:') ? field.slice('axis:'.length) : null
)

/**
 * The sort the list actually uses: `field`, unless it orders by a metric that is no
 * longer active (an admin archived it, or the setup changed under an open page) — then
 * the priority score, which always exists.
 */
export function effectiveSortField(field: SortField, active: readonly { readonly id: string }[]): SortField {
  const axisId = sortAxisId(field)
  return axisId === null || active.some((axis) => axis.id === axisId) ? field : 'priority_score'
}

/**
 * The score of a row with no stored ballot: no axis value at all, and an absent axis
 * MEANS UNSCORED (the API's 0). One sentinel for every configured metric, so the
 * sliders RENDER unscored instead of borrowing a number from the middle of the range
 * (#343).
 */
export const DEFAULT_SCORE: PrioritizationScore = {
  row_id: '',
  values: {},
  notes: '',
}

/** The value a ballot holds for one axis — 0 (not scored) when it holds none. */
export function axisValue(score: Pick<PrioritizationScore, 'values'>, axisId: string): number {
  return Object.hasOwn(score.values, axisId) ? score.values[axisId] ?? 0 : 0
}

/**
 * The longest note a ballot may carry.
 *
 * Duplicated from `MAX_BALLOT_NOTE_LEN` in the backend's `projects_handler.py`,
 * which REFUSES a longer note rather than truncating it — the characters past the
 * bound are content, not a number that can be clamped. So the page has to know the
 * number too: a 400 the page does not anticipate surfaces only as an `ApiError`
 * after the click, i.e. a Save button that appears to do nothing, instead of a
 * counter that stops the user before saving.
 *
 * The pair is pinned by
 * `lambda/api/test/test_prioritization_note_bound_lockstep.py`, because a comment
 * saying the two agree cannot fail CI.
 */
export const MAX_NOTE_LENGTH = 2000

/**
 * The rows among the caller's pending edits whose note the API will refuse.
 *
 * Only pending edits are examined, because those are what a save sends: a
 * pre-ballot note that ran long stays readable on an untouched row and blocks
 * nothing.
 *
 * `maxLength` on the textarea stops a reviewer TYPING past the bound, but it does
 * not shorten a value that was already over it when the page loaded — the
 * pre-ballot map was written by a route with no bound at all — and touching any
 * slider on such a row sends the note along with it. So the bound has to be checked
 * before the request, not only prevented at the keyboard.
 *
 * Typed for the shape it READS — an optionally-absent note — rather than for
 * `PrioritizationScore`, which declares `notes` as a required string. A stored
 * ballot arrives from the network with no runtime guarantee it matches that
 * declaration, and a save is the wrong moment to discover otherwise: ballots
 * written before a partial save carried no note at all. `PrioritizationScore` is
 * still assignable to this, so the call site is unaffected, and the tolerance is in
 * the signature instead of behind a cast in a test.
 */
export function overLongNoteRows(
  edits: Record<string, { readonly notes?: string | null }>,
): string[] {
  return Object.entries(edits)
    .filter(([, score]) => noteLength(score.notes) > MAX_NOTE_LENGTH)
    .map(([rowId]) => rowId)
}

/**
 * The note's length in the unit the API measures it in.
 *
 * `.length` is UTF-16 CODE UNITS; Python's `len()` on the other side of the wire is
 * CODE POINTS. They differ for anything outside the basic plane — an emoji is two
 * units and one code point — so a plain `.length` blocks a note of 1500 emoji that
 * the API would have accepted, with a message quoting a limit the reviewer had not
 * reached. Spreading the string iterates by code point, which is what makes the two
 * sides bound the same thing rather than the same number.
 *
 * `maxLength` on the textarea cannot be corrected this way: the DOM attribute counts
 * code units, full stop. It is left as the tighter of the two on purpose — it only
 * limits TYPING and can therefore never produce a body the API refuses, which is the
 * invariant that matters. A reviewer pasting emoji past it is bounded early rather
 * than told a save failed.
 */
function noteLength(notes: string | null | undefined): number {
  return Array.from(notes ?? '').length
}

/**
 * The caller's own ballot for one document, or the display defaults when they have none.
 *
 * `Object.hasOwn` rather than a nullish check on the lookup, matching `getTeamScore`: `??`
 * does not fire on an inherited value, so `getScore(scores, 'toString')` answered
 * `Object.prototype.toString` — a function where a `PrioritizationScore` is declared, and
 * every axis on it `undefined`. Ids are server-minted so this was not reachable in
 * practice, but it was the only unguarded map lookup left on a page whose method is one
 * rule in one place, and its sibling is both documented and tested.
 */
export function getScore(scores: Record<string, PrioritizationScore>, rowId: string): PrioritizationScore {
  const stored = Object.hasOwn(scores, rowId) ? scores[rowId] : undefined
  return stored ?? {
    ...DEFAULT_SCORE,
    row_id: rowId,
  }
}

/** One change a reviewer made: a metric moved, or the note edited. */
export type BallotChange =
  | { readonly field: 'axis'; readonly axisId: string; readonly value: number }
  | { readonly field: 'notes'; readonly value: string }

/** The edit after `change`, without inventing the fields beside it. */
function withChange(edit: PrioritizationBallotEdit, change: BallotChange): PrioritizationBallotEdit {
  if (change.field === 'notes') return { ...edit, notes: change.value }
  return { ...edit, values: { ...edit.values, [change.axisId]: change.value } }
}

/** The pending edit reduced to what really differs from the saved ballot, or `null`. */
function changedOnly(edit: PrioritizationBallotEdit, baseline: PrioritizationScore): PrioritizationBallotEdit | null {
  const values = Object.fromEntries(Object.entries(edit.values ?? {})
    .filter(([axisId, value]) => value !== axisValue(baseline, axisId)))
  const notesChanged = edit.notes !== undefined && edit.notes !== baseline.notes
  const hasValues = Object.keys(values).length > 0
  if (!hasValues && !notesChanged) return null
  return {
    row_id: edit.row_id,
    ...(hasValues ? { values } : {}),
    ...(notesChanged ? { notes: edit.notes } : {}),
  }
}

/**
 * The edits after applying `change` to `rowId`, keeping only what really differs from
 * the saved ballot: a slider moved and moved back is NO change, so the field drops out —
 * and a row left with no changed field drops out entirely, which is what keeps Save (and
 * the unsaved-changes guard) disabled for it.
 */
export function withBallotEdit(
  edits: Readonly<Record<string, PrioritizationBallotEdit>>,
  saved: Record<string, PrioritizationScore>,
  rowId: string,
  change: BallotChange,
): Record<string, PrioritizationBallotEdit> {
  const kept = changedOnly(withChange(edits[rowId] ?? { row_id: rowId }, change), getScore(saved, rowId))
  const others = Object.fromEntries(Object.entries(edits).filter(([id]) => id !== rowId))
  return kept === null ? others : { ...others, [rowId]: kept }
}

/**
 * The ballots as the sliders should show them: what was saved, under what was edited.
 *
 * Merged per FIELD (and per axis): a pending edit carries ONLY what the reader set, so a
 * spread of one object over the other would blank a saved axis the edit says nothing
 * about. Displayed scores stay derived rather than snapshotted, so a refetch after saving
 * shows the server's latest values (issue #95).
 */
export function applyBallotEdits(
  saved: Record<string, PrioritizationScore>,
  edits: Record<string, PrioritizationBallotEdit>,
): Record<string, PrioritizationScore> {
  const edited = Object.entries(edits).map(([rowId, edit]): [string, PrioritizationScore] => {
    const base = getScore(saved, rowId)
    return [rowId, {
      row_id: rowId,
      values: { ...base.values, ...edit.values },
      notes: edit.notes ?? base.notes,
    }]
  })
  return {
    ...saved,
    ...Object.fromEntries(edited),
  }
}

/**
 * The edits as `PATCH /projects/prioritization` takes them: each axis a top-level number
 * named by its id, exactly how ballots are stored. Only what the reviewer set is sent —
 * an omitted axis means "leave it alone".
 */
export function toWireBallotEdits(
  edits: Readonly<Record<string, PrioritizationBallotEdit>>,
  active: readonly { readonly id: string }[],
): Record<string, WireBallotEdit> {
  // Only ACTIVE axes: an admin may archive a metric while this reviewer has an unsaved
  // value on it, and the API refuses an archived id (400) — which would lose the rest.
  const isActive = (axisId: string) => active.some((axis) => axis.id === axisId)
  return Object.fromEntries(Object.entries(edits).map(([rowId, edit]): [string, WireBallotEdit] => [rowId, {
    row_id: edit.row_id,
    ...Object.fromEntries(Object.entries(edit.values ?? {}).filter(([axisId]) => isActive(axisId))),
    ...(edit.notes === undefined ? {} : { notes: edit.notes }),
  }]))
}

/**
 * Per-type display metadata for every scorable document type.
 *
 * This is the single source of truth for which document types are scorable.
 * Keys are constrained to `ProjectDocument['document_type']`, so a typo or
 * stale entry is a compile error. Adding a new scorable type here automatically
 * propagates to `isScorable`, to the `DocumentTypeBadge` in `PRFAQRow`, and to
 * the document select in `pages/FeedbackForms/ValidationLinkPicker`.
 *
 * `i18nKey` is namespace-QUALIFIED (`prioritization:…`) rather than relative,
 * for two reasons. It is read through a `t` bound to another namespace — the
 * validation-link picker's is `feedbackForms` — and a relative key would resolve
 * against that namespace and render the raw path. And a bare `'docType.prd'` is
 * invisible to `scripts/i18n-check.mjs`: keys held in data are only collected
 * when they carry a namespace (see `extractDataHeldKeys`), so without the prefix
 * these two are reported unused and become deletion candidates in a cleanup
 * pass, leaving the badge and the select rendering `docType.prd`.
 *
 * The prefix is in the TYPE, not only in the values: as a plain `string` field,
 * dropping it was a valid compile and only a test stood between that and raw key
 * paths in the UI. `tsc` now rejects it at the definition, and the resolution
 * gate in `prioritizationUtils.test.ts` remains the runtime check — vitest runs
 * through esbuild and does not typecheck, so the type alone would not have
 * failed a suite.
 */
export const SCORABLE_TYPE_META: Partial<Record<ProjectDocument['document_type'], {
  readonly i18nKey: `prioritization:${string}`
}>> = {
  // No tone per type: a document type is a descriptive label, so the row badge is
  // `badge-muted` with the type's icon (components/DocumentTypeBadge) — labels vs status.
  prd: { i18nKey: 'prioritization:docType.prd' },
  prfaq: { i18nKey: 'prioritization:docType.prfaq' },
}

export function isScorable(doc: ProjectDocument): boolean {
  // `in` operator checks key presence in SCORABLE_TYPE_META at runtime;
  // the type of `doc.document_type` is already constrained by the API union,
  // so no type assertion is needed and any typo in SCORABLE_TYPE_META is a
  // compile error at the Partial<Record<...>> definition above.
  return doc.document_type in SCORABLE_TYPE_META
}
