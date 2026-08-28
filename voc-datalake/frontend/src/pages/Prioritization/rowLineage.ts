/**
 * @fileoverview Whether the documents one prioritization row holds tell ONE
 * story — and, for a frozen row, whether a fresher one exists.
 *
 * The row model already stores CONCRETE document ids (see `PrioritizationRow`),
 * which is what keeps a ballot describing the combination it was cast on. The
 * cost of that promise is the question this module answers: a reviewer looking at
 * a row cannot tell "these documents were generated as one generation" from
 * "somebody ticked a PRD from March and a PR/FAQ from January", and a frozen row
 * silently goes on describing a generation the project has moved past.
 *
 * NOTHING HERE IS NEW DATA. Every answer is read off the derivation contract at
 * `api/derivation.ts` — `resolveDerivation` per selected document, which reports
 * the same shape for a declared `derivation` map and for the three legacy lineage
 * shapes that predate it (`source_prd_id`, `source_prfaq_id`, `source_documents`)
 * — plus the documents' own `document_type` and `created_at`, which the project
 * read already carries. No route changes, no new field on the wire.
 *
 * ROLE-BLIND ON PURPOSE. Every entry of the closed role vocabulary
 * (`DERIVATION_ROLES`: reference, prototype_prd, prototype_prfaq, merge_input) is
 * read as one thing — "this document was built from that one" — because that is
 * the only property a generation check needs, and a rule naming a subset of the
 * roles would go quietly stale the moment a fifth role is added (the frontend
 * copy of that vocabulary is a compile error away from the backend's, which is a
 * guarantee about the LIST and not about who reads it). The two prototype roles
 * are unreachable from a row's own documents today — a row holds only scorable
 * documents, and `isScorable` excludes a prototype — but the rule is total over
 * the vocabulary rather than true by accident of what a row may hold.
 *
 * EVERY STATE REMAINS SCORABLE, and this module is why that is structural rather
 * than remembered: it returns a state, never a control. Nothing here disables a
 * slider, hides a picker or filters a row, and the presentation
 * (`RowLineageBadge`) renders words in every state. A row whose lineage cannot be
 * read is a row whose EVIDENCE is weaker, not a row nobody may score — the same
 * reading `resolveDerivation` takes when it answers `origin: 'none'` for a
 * hand-authored document rather than treating it as an error.
 *
 * Pure and total, like the contract it reads: no React, no throwing, and an
 * unreadable document — null, a string, a record with no id — contributes nothing
 * rather than failing a row.
 *
 * @module pages/Prioritization/rowLineage
 */

import { resolveDerivation } from '../../api/derivation'
import { asRecord, displayString } from '../../api/wireRecord'

/**
 * What the documents on one row say about each other.
 *
 * THREE STATES, kept apart by the type rather than by a colour, because the row
 * has to be able to SAY which one it is: `'absent'` and `'crossGeneration'` would
 * both be "the grey one" to a reader who cannot see the tint, and they license
 * different sentences — "these documents cross generations" is a statement about
 * the combination somebody chose, while "no lineage was recorded" is a statement
 * about what the documents can say at all, and it is the ordinary answer for a
 * hand-authored document (`origin: 'none'`) rather than a fault.
 */
export type LineageState = 'coherent' | 'crossGeneration' | 'absent'

/**
 * WHY a selection reads as it does — one code per rule below, so the reason
 * survives the trip to the UI as data instead of being re-derived there.
 *
 * A separate axis from `LineageState` because two different rules produce
 * `'crossGeneration'` and a reader can act on the difference: a row holding two
 * PRDs is a combination somebody can un-tick, while a row whose PR/FAQ was built
 * from the OTHER PRD is a mismatch between what was picked and what was
 * generated. Collapsing them into one sentence would describe neither.
 */
export type LineageReason = 'oneChain' | 'repeatedType' | 'supersededSource' | 'noneRecorded'

/** How one selection of documents reads: the state, and the rule that decided it. */
export interface SelectionLineage {
  readonly state: LineageState
  readonly reason: LineageReason
}

/** A row's lineage, plus the staleness only a FROZEN row can be in. */
export interface RowLineage extends SelectionLineage {
  /**
   * Is this a frozen row for which a genuinely fresher COHERENT combination of
   * the same document types exists?
   *
   * Never true for an un-frozen row, and that is a rule rather than an
   * optimisation: a row whose composition can still change has a better answer
   * than "add another row" — edit this one — so telling its reader to add a row
   * would send them the long way round. See `fresherCoherentSelection`.
   */
  readonly stale: boolean
  /**
   * The fresher combination, in the order the row's own document types appear, or
   * empty when there is none.
   *
   * Carried rather than only the boolean so a caller can NAME what to score
   * without recomputing it — and deliberately NOT applied to the row: the frozen
   * row keeps the concrete ids its ballots were cast on, which is the whole point
   * of freezing it, and the suggested action is adding a row.
   */
  readonly fresherDocumentIds: readonly string[]
}

/** Shared empty list, so the common non-stale answer allocates nothing. */
const NO_IDS: readonly string[] = []

/**
 * One document reduced to what a generation check reads off it.
 *
 * `type` and `createdAt` may be '' — `displayString` collapses absent, null and
 * wrong-typed into one value — and EVERY RULE THAT WOULD ACT ON THE FIELD
 * requires a non-empty value first, so an unreadable field withholds a judgement
 * instead of inventing one. Both halves of that are load-bearing and both are
 * spelled out where they are enforced, because '' is not a neutral value here:
 *
 *  * an unreadable `type` is skipped by `repeatsAType`, is not compared against a
 *    source's type in `hasSupersededSource`, and withholds staleness altogether
 *    in `fresherCoherentSelection` — a type nobody can read states no expectation
 *    about what belongs beside it;
 *  * an unreadable `createdAt` LOSES every comparison (it is the smallest string,
 *    and parses as no instant), so ranking one would report a row superseded by an
 *    arbitrarily older document. `fresherCoherentSelection` therefore withholds
 *    staleness rather than ranking it — see its own docstring, which records the
 *    one place a date-less document is still ignored rather than decisive.
 */
interface SelectedDocument {
  readonly id: string
  readonly type: string
  readonly createdAt: string
}

/**
 * A wire document as a selection entry, or null when it cannot be one.
 *
 * An id is required and nothing else is: an entry naming no document cannot be
 * compared with anything, while a record with an id and no type is still a
 * document the row holds and still contributes its lineage. Same tolerance as
 * `numberable` in api/documentLineage.ts, one field looser for the same stated
 * reason — the `total` there is rendered, and nothing here is.
 */
function selectionEntry(raw: unknown): SelectedDocument | null {
  const record = asRecord(raw)
  if (record === null) return null
  const id = displayString(record.document_id)
  if (id === '') return null
  return {
    id,
    type: displayString(record.document_type),
    createdAt: displayString(record.created_at),
  }
}

function selectionEntries(selection: readonly unknown[]): SelectedDocument[] {
  return selection.flatMap((raw) => {
    const entry = selectionEntry(raw)
    return entry === null ? [] : [entry]
  })
}

/**
 * Does the selection hold two documents of ONE type — two generations of the same
 * artifact?
 *
 * Decided from the documents alone, with no derivation read at all, which is why
 * it outranks every other rule below: nothing a `derivation` map could say makes
 * two PRDs in one row one generation. The reasoning is `ordinalByType`'s in
 * api/documentLineage.ts — creation order WITHIN a type is what a version is
 * here, nothing stores one — so a second document of a type is by construction
 * another version of it.
 *
 * A document whose type could not be read is skipped rather than grouped under
 * '': two type-less records are not evidence of anything, and grouping them would
 * make unrelated documents each other's generations, which is the same trap
 * `numberable` records for the ordinal.
 */
function repeatsAType(selected: readonly SelectedDocument[]): boolean {
  const seen = new Set<string>()
  for (const entry of selected) {
    if (entry.type === '') continue
    if (seen.has(entry.type)) return true
    seen.add(entry.type)
  }
  return false
}

/**
 * Was some selected document built from a document of a type this row holds a
 * DIFFERENT copy of?
 *
 * The mismatch that has nothing on screen today: a PR/FAQ generated from PRD 1
 * sitting in a row beside PRD 2. The PR/FAQ's own derivation names PRD 1, PRD 1
 * is not in the row, and the row holds another document of PRD 1's type — so the
 * combination crosses generations however plausible its two titles look.
 *
 * "SOME OTHER selected document", never "some selected document", and that
 * distinction is the whole correctness of this rule. A regenerated PRD names the
 * previous PRD as a source (a merge, a revision), so a row holding {PRD 2, PR/FAQ
 * 2} contains a document whose source has a type the row also holds — its own.
 * Compared against the types of the OTHER documents, that row is coherent, which
 * it plainly is: the row holds the newer generation of exactly that type.
 *
 * A source that does NOT resolve — deleted since, or a project read that does not
 * carry it — is skipped: `resolveDerivation` reports it with `document_type:
 * null` rather than dropping it (the relation outlives its target), and a type
 * nobody can read cannot be compared with the row's. Withholding the crossing is
 * the honest half of that: the row is not proved incoherent, and the state stays
 * scorable either way. That null check is enforced by `tsc` rather than by a test
 * — `Set<string>.has` refuses `string | null`, so dropping it does not compile —
 * which is why `rowLineage.test.ts` covers the deleted-source OUTCOME instead of
 * claiming to catch the check going missing.
 *
 * AN UNREADABLE TYPE IS NOT A TYPE, on both sides of the comparison, and `null` is
 * not the only spelling of one. A source that DID resolve to a document whose
 * `document_type` could not be read comes back as '' rather than null
 * (`sourceFieldIndex` runs it through `displayString`), and a held document whose
 * type could not be read carries '' too — so an unfiltered `otherTypes` matches ''
 * against '' and declares a crossing between two documents neither of which was
 * shown to be of the same kind. Type-less held documents are therefore dropped
 * from `otherTypes`, which is the same reading `repeatsAType` takes when it skips
 * them and `fresherCoherentSelection` takes when it withholds staleness for one:
 * an unreadable field decides nothing anywhere in this module.
 */
function hasSupersededSource(
  selection: readonly unknown[],
  selected: readonly SelectedDocument[],
  projectDocuments: readonly unknown[],
): boolean {
  const selectedIds = new Set(selected.map((entry) => entry.id))
  return selection.some((raw) => {
    const entry = selectionEntry(raw)
    if (entry === null) return false
    // The READABLE types held by the OTHER documents of this row — see the
    // docstring for both halves: why it is the other documents, and why '' is
    // excluded rather than treated as a type that two documents can share.
    const otherTypes = new Set(
      selected
        .filter((held) => held.id !== entry.id && held.type !== '')
        .map((held) => held.type),
    )
    return resolveDerivation(raw, projectDocuments).sources.some((source) => (
      !selectedIds.has(source.document_id)
      && source.document_type !== null
      && otherTypes.has(source.document_type)
    ))
  })
}

/**
 * Can NOTHING in this selection say what it was built from?
 *
 * `origin === 'none'` is `resolveDerivation`'s own answer for "this document
 * cannot say", covering an absent `derivation` map, a stored null, a declared but
 * empty record AND the legacy shapes coming back with nothing — so this asks the
 * contract rather than re-testing its inputs. Every document, not any: one
 * document that records its inputs is lineage the row can be judged on, and the
 * rest not recording theirs is the ordinary shape of a project that predates the
 * field.
 */
function recordsNoLineage(
  selection: readonly unknown[],
  projectDocuments: readonly unknown[],
): boolean {
  return selection.every((raw) => resolveDerivation(raw, projectDocuments).origin === 'none')
}

/**
 * How one selection of documents reads: coherent, crossing generations, or
 * unable to say.
 *
 * THE RULES IN ORDER, and the order is load-bearing:
 *
 *  1. two documents of one TYPE — decided without reading any derivation, so no
 *     lineage record can talk a row out of it;
 *  2. a document built from another GENERATION of a type the row also holds;
 *  3. nothing in the row records what it was built from at all;
 *  4. otherwise coherent.
 *
 * WHAT COHERENT CLAIMS, and what it deliberately does not. It is "nothing here
 * contradicts one derivation chain, and at least one of these documents can say
 * what it was built from" — NOT "a chain provably links them". Requiring a proven
 * edge between the selected documents was tried and rejected: a PRD and a PR/FAQ
 * generated from the same feedback in the same sitting have no edge to each other
 * (each names feedback and personas, neither names the other), so the rule would
 * grey the ordinary shape of the ordinary row and leave the signal saying nothing
 * about anything. A signal that is grey for everybody is not a signal.
 *
 * @param selection The row's own documents, as the project read supplied them.
 *   Concrete records rather than ids, because the caller has already resolved
 *   them (`collectRows`) and a second lookup could disagree with the first.
 * @param projectDocuments The project's documents, used only to resolve what each
 *   recorded source IS — its type. A source that is not among them stays
 *   unresolved and decides nothing; see `hasSupersededSource`.
 */
export function classifySelectionLineage(
  selection: readonly unknown[],
  projectDocuments: readonly unknown[],
): SelectionLineage {
  const selected = selectionEntries(selection)
  if (repeatsAType(selected)) {
    return {
      state: 'crossGeneration',
      reason: 'repeatedType',
    }
  }
  if (hasSupersededSource(selection, selected, projectDocuments)) {
    return {
      state: 'crossGeneration',
      reason: 'supersededSource',
    }
  }
  if (recordsNoLineage(selection, projectDocuments)) {
    return {
      state: 'absent',
      reason: 'noneRecorded',
    }
  }
  return {
    state: 'coherent',
    reason: 'oneChain',
  }
}

/**
 * Newest-first rank of a document, the same rule `ordinalByType` orders a type by:
 * `created_at`, then `document_id` to break a tie.
 *
 * The tie-break is not decoration. A PRD and a PR/FAQ generated from one request
 * share a timestamp (the defect `byNewestFirst`'s equal arm exists for), and two
 * documents of ONE type can share one too — a comparison with no tie-break would
 * then answer "fresher" for whichever way round the array happened to be, and a
 * frozen row would read as stale or current depending on the order a read
 * returned its documents in.
 *
 * NO DECISION RESTS ON AN UNREADABLE TIMESTAMP. '' is the smallest string, so a
 * date-less document ranks below every dated one — INCLUDING far older ones — and
 * a "fresher" answer resting on that would read "superseded by a document from
 * 2020". `fresherCoherentSelection` therefore refuses the comparison before making
 * it, on the row's documents and on the candidate both (`hasUnreadableTimestamp`).
 * `newestOfType` still ranks a date-less project document, which is the one safe
 * use: last within its type, so it can only be chosen when the project holds
 * nothing else of that type — and that candidate is then refused too.
 */
function rankOf(document: SelectedDocument): readonly [string, string] {
  return [document.createdAt, document.id]
}

/** Is `a` strictly newer than `b` under `rankOf`? */
function isNewer(a: readonly [string, string], b: readonly [string, string]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0]
  return a[1] > b[1]
}

/**
 * Does any of these documents carry a timestamp nobody can read?
 *
 * The staleness gate for `createdAt`, exactly parallel to the type gate beside it,
 * and for a sharper reason: '' does not merely fail to state an expectation, it
 * states the WRONG one. `displayString` collapses absent, null and non-string into
 * '', which loses every lexicographic comparison in `isNewer`, so a held document
 * with an unreadable timestamp is ranked below every dated document of its type —
 * and the row is then told its evidence was superseded by whichever document the
 * project happens to hold, however old. A 2020 document "superseding" a row is not
 * a near-miss; it is advice to go and score older evidence.
 *
 * There IS a precedent for "no timestamp sorts oldest" — `_default_row_composition`
 * in projects_handler.py records that reasoning — but it picks a default composition
 * there, where being wrong costs a reviewer one un-tick. Here the same guess drives
 * a sentence asking somebody to create a row and re-score a proposal, so the
 * asymmetry argues the other way and this withholds instead.
 *
 * Asked of the row's OWN documents and of the candidate that would be advised —
 * both sides of the comparison, because either being unreadable makes the answer a
 * guess. NOT asked of every project document: a date-less document that is not
 * chosen as the newest of its type simply loses to a dated sibling, which withholds
 * an advisory rather than inventing one, and letting one unreadable record anywhere
 * in a project silence every row's staleness would trade this defect for a quieter
 * one.
 */
function hasUnreadableTimestamp(documents: readonly SelectedDocument[]): boolean {
  return documents.some((entry) => entry.createdAt === '')
}

/** The project's newest document of one type, or null when it holds none. */
function newestOfType(
  projectDocuments: readonly SelectedDocument[],
  type: string,
): SelectedDocument | null {
  return projectDocuments
    .filter((entry) => entry.type === type)
    .reduce<SelectedDocument | null>(
      (newest, entry) => (newest === null || isNewer(rankOf(entry), rankOf(newest)) ? entry : newest),
      null,
    )
}

/**
 * The ids of a genuinely fresher COHERENT combination for this selection, or null
 * when there is none.
 *
 * WHAT "UNDER THE SAME ROLE EXPECTATIONS" MEANS HERE: the candidate holds the
 * project's newest document of each TYPE the selection holds, and nothing else. A
 * row scored on a PRD and a PR/FAQ is compared with the newest PRD and the newest
 * PR/FAQ; a row scored on a PR/FAQ alone is compared with the newest PR/FAQ
 * alone, and the project having since gained its first PRD does NOT make that row
 * stale — the row was never about a PRD, and telling its reader otherwise would
 * turn "your evidence has been superseded" into "you could have picked more".
 * That is the missing-optional-document boundary, decided here rather than left
 * to the caller.
 *
 * FIVE CONDITIONS, every one of which can withhold staleness, because the
 * sentence this drives asks a reviewer to create a row:
 *
 *  * the selection must name one READABLE type per document — a row already
 *    holding two generations of a type has no single "same expectations"
 *    candidate to compare with (and is already reported as crossing
 *    generations, which is the more useful thing to say about it), and a
 *    document whose type cannot be read has no expectation to state at all:
 *    grouping such documents under '' would make one project document answer
 *    for two of the row's, which is the same trap `repeatsAType` skips;
 *  * every document being COMPARED must carry a readable `created_at`, on the
 *    row's side and on the candidate's — an unreadable one loses every
 *    comparison and would have the row superseded by an arbitrarily older
 *    document. See `hasUnreadableTimestamp`, which is where the asymmetry
 *    between "guess wrong about a default" and "guess wrong in an advisory" is
 *    argued;
 *  * every type must still resolve to a document of the project, so a candidate
 *    is a set of documents that exist rather than of ids;
 *  * the candidate must be STRICTLY NEWER — at least one type answering a newer
 *    document, and none answering an older one. A candidate that merely differs
 *    is not fresher, and the identical candidate is the ordinary state of a frozen
 *    row that is perfectly current;
 *  * the candidate must itself be COHERENT. "The newest of each type" is not
 *    automatically one generation: a project whose newest PR/FAQ was built from
 *    the previous PRD produces a newest-of-each candidate that crosses
 *    generations, and pointing a reviewer at it would trade a stale row for an
 *    incoherent one. This is the condition that makes the criterion "a REAL
 *    fresher coherent combination exists" rather than "something newer exists".
 */
export function fresherCoherentSelection(
  selection: readonly unknown[],
  projectDocuments: readonly unknown[],
): readonly string[] | null {
  const selected = selectionEntries(selection)
  if (selected.length === 0 || repeatsAType(selected)) return null
  // A type nobody can read states no expectation — see the docstring's first
  // condition. Left in, `newestOfType(available, '')` would answer the project's
  // newest type-less record for it, which is a comparison between two documents
  // neither of which was shown to be of the same kind.
  if (selected.some((held) => held.type === '')) return null
  // A timestamp nobody can read states the WRONG expectation rather than none: ''
  // loses every comparison, so ranking it would report this row superseded by
  // whatever the project holds, however old. Asked of the row's own documents
  // before any candidate is formed — see `hasUnreadableTimestamp`.
  if (hasUnreadableTimestamp(selected)) return null
  // Records, not entries, because the coherence check below reads each candidate's
  // own derivation — which only the wire record carries.
  const byId = new Map<string, unknown>()
  for (const raw of projectDocuments) {
    const entry = selectionEntry(raw)
    if (entry !== null) byId.set(entry.id, raw)
  }
  const available = selectionEntries(projectDocuments)
  const candidate = selected.map((held) => newestOfType(available, held.type))
  if (candidate.some((entry) => entry === null)) return null
  const chosen = candidate.flatMap((entry) => (entry === null ? [] : [entry]))
  // NO SECOND GATE FOR THE CANDIDATE'S timestamps, and that is a proof rather than an
  // omission: the row's own are readable by the check above, so a candidate whose
  // `createdAt` is '' loses `isNewer` against the document the row holds of that type
  // and `regressed` below returns null. A gate here would be a branch no input can
  // reach, which is worse than the sentence explaining why.
  // STRICTLY NEWER, which is also what answers the commonest case — a frozen row
  // already holding the newest of each type. That row's candidate IS its own
  // selection, so nothing is newer and `fresher` is false; an `every(id === id)`
  // early return above this was the same question asked twice, and a second spelling
  // of one rule is where the two come to disagree. `regressed` is the other half: no
  // type may answer something OLDER than the row holds, or a sideways move would read
  // as an improvement.
  const fresher = chosen.some((entry, index) => isNewer(rankOf(entry), rankOf(selected[index])))
  const regressed = chosen.some((entry, index) => isNewer(rankOf(selected[index]), rankOf(entry)))
  if (!fresher || regressed) return null
  const records = chosen.flatMap((entry) => {
    const record = byId.get(entry.id)
    return record === undefined ? [] : [record]
  })
  if (classifySelectionLineage(records, projectDocuments).state !== 'coherent') return null
  return chosen.map((entry) => entry.id)
}

/**
 * One row's lineage, as the row renders it.
 *
 * The row's OWN documents are the selection — the concrete ids the server stored,
 * already resolved against the project read by `collectRows` — so this reads the
 * same combination the ballots were cast on and never a recomputed "latest of
 * each type", which is the pointer a frozen row exists to avoid being.
 *
 * Staleness is asked only of a FROZEN row. An un-frozen row with the very same
 * fresher documents available is not stale, because its answer is to edit itself:
 * the composition controls are right there, and "add a row" would be advice to
 * take the long way round. See `RowLineage.stale`.
 */
export function rowLineageOf(
  row: {
    readonly is_frozen: boolean
    readonly documents: readonly unknown[]
  },
  projectDocuments: readonly unknown[],
): RowLineage {
  const lineage = classifySelectionLineage(row.documents, projectDocuments)
  const fresher = row.is_frozen
    ? fresherCoherentSelection(row.documents, projectDocuments)
    : null
  return {
    ...lineage,
    stale: fresher !== null,
    fresherDocumentIds: fresher ?? NO_IDS,
  }
}

/**
 * How each lineage state is named and tinted. One table, so the badge and
 * anything else that describes a row agree.
 *
 * `labelKey` is namespace-QUALIFIED, and the prefix is in the TYPE as well as the
 * value, for the reason recorded on `BAND_STYLE` and `SCORABLE_TYPE_META`:
 * `scripts/i18n-check.mjs` only collects a data-held key that carries a namespace
 * (see `extractDataHeldKeys`), so a bare `'lineage.coherent'` is invisible to the
 * gate, is reported unused, and becomes a deletion candidate in a cleanup pass —
 * leaving every row labelled with a raw key path. Dropping the prefix is a
 * compile error rather than only a test failure.
 *
 * COLOUR IS NEVER THE SIGNAL, only its reinforcement: every state carries a text
 * label and a reason, so a reader who cannot tell amber from grey still reads
 * which state a row is in. Contrast measured against the same Tailwind v4 palette
 * `BAND_STYLE` records, on each tint at `text-xs` where AA wants 4.5:1 —
 * emerald-800 #016630 on emerald-100 #dbfce7 is 7.06:1, amber-800 #973c00 on
 * amber-100 #fef3c6 is 5.68:1, gray-600 #4a5565 on gray-100 #f3f4f6 is 6.87:1.
 */
export const LINEAGE_STYLE: Record<LineageState, {
  readonly labelKey: `prioritization:${string}`
  readonly color: string
}> = {
  coherent: {
    labelKey: 'prioritization:lineage.coherent',
    color: 'bg-emerald-100 text-emerald-800',
  },
  crossGeneration: {
    labelKey: 'prioritization:lineage.crossGeneration',
    color: 'bg-amber-100 text-amber-800',
  },
  // The same grey the read-state bands use, and for a related reason: this says
  // what the DOCUMENTS can tell us, not how good the proposal is. A tint that read
  // as a warning would present a hand-authored PRD as a problem with the row.
  absent: {
    labelKey: 'prioritization:lineage.absent',
    color: 'bg-gray-100 text-gray-600',
  },
}

/**
 * The sentence each reason gets.
 *
 * A `Record` over the union rather than a ternary at the call site, matching
 * `READ_STATE_I18N_KEY`: a fifth reason must be given a sentence to compile,
 * instead of silently falling into somebody's else branch and describing a row
 * with the wrong words.
 *
 * The key sits under a property NAMED `sentenceKey` rather than being the record's
 * value directly, which is the shape `FAILURE_I18N_KEY` uses one module over and
 * for the same mechanical reason: `extractDataHeldKeys` only collects a
 * namespace-qualified literal under a property whose NAME ends in `Key`
 * (`/\b\w*[Kk]ey:/`), so keyed by reason name alone these four are invisible to
 * the gate — reported unused, and deletion candidates in a cleanup pass that would
 * leave every row's reason rendering a raw key path. Measured, not assumed: keyed
 * the short way, `npm run i18n:check` listed all four as unreferenced.
 */
export const LINEAGE_REASON_KEY: Record<LineageReason, {
  readonly sentenceKey: `prioritization:${string}`
}> = {
  oneChain: { sentenceKey: 'prioritization:lineage.coherentReason' },
  repeatedType: { sentenceKey: 'prioritization:lineage.repeatedTypeReason' },
  supersededSource: { sentenceKey: 'prioritization:lineage.supersededSourceReason' },
  noneRecorded: { sentenceKey: 'prioritization:lineage.absentReason' },
}
