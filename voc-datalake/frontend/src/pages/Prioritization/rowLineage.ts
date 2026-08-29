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
   * Is this a frozen row for which a genuinely fresher combination of the same
   * document types exists, one that does not itself cross generations?
   *
   * "DOES NOT CROSS GENERATIONS" rather than "is coherent", which is one state
   * looser and deliberately so: a candidate in which nothing records what it was
   * built from (`absent`) is still advisable, because the staleness arithmetic
   * reads only type and timestamp and absent lineage is the ordinary state of a
   * pre-`derivation` project. Only a positively contradictory candidate withholds.
   * Argued at the condition itself in `fresherCoherentSelection`.
   *
   * Never true for an un-frozen row, and that is a rule rather than an
   * optimisation: a row whose composition can still change has a better answer
   * than "add another row" — edit this one — so telling its reader to add a row
   * would send them the long way round. See `fresherCoherentSelection`.
   *
   * Never true for a row whose stored composition could not be fully resolved
   * either — see `composition_truncated` on the argument to `rowLineageOf`, which
   * is the one input that makes the SELECTION itself untrustworthy rather than
   * some document in it.
   */
  readonly stale: boolean
  /**
   * The COMBINATION to score instead — the project's newest document of each type
   * the row holds, in the order the row's own documents appear — or empty when
   * there is none.
   *
   * "THE NEWEST OF EACH TYPE", NOT "the documents that changed", and a consumer has
   * to know which: staleness fires when at least ONE type has a newer version
   * (`fresher` is `some`), so a type with nothing newer resolves to the id the row
   * ALREADY holds. A row whose PRD gained a v2 while its PR/FAQ did not reports
   * `['prd_2', 'prfaq_1']`. That is right for the eventual consumer — pre-selecting
   * the combination in the Add-row picker, where the new row genuinely needs both
   * ids — and wrong for a renderer listing "what is newer", which would name a
   * document the reviewer is already looking at.
   *
   * A TYPE WHOSE NEWEST ONLY TIES resolves to the held id too, for the reason the
   * freshness verdict compares instants alone: an id is not evidence of recency.
   * `newestOfType` must break a same-instant tie on `document_id` — choosing a type's
   * newest document needs a total order — but once some OTHER type is genuinely newer,
   * that tie-break would otherwise decide the CONTENT of this list and substitute a
   * same-instant sibling the row does not hold. See `fresherCoherentSelection`.
   *
   * Carried rather than only the boolean so such a caller can name the combination
   * without recomputing it, and deliberately NOT applied to the row: the frozen row
   * keeps the concrete ids its ballots were cast on, which is the whole point of
   * freezing it, and the suggested action is adding a row. No renderer reads it
   * today — `RowStaleBadge` and `RowLineageNote` take only `stale` and `reason` —
   * which is a gap in the UI rather than in this field.
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
 *  * a `createdAt` that names NO INSTANT loses every comparison — '' and any other
 *    value outside the grammar `instantOf` reads rank as `NO_INSTANT`, below every
 *    dated document —
 *    so ranking one would report a row superseded by an arbitrarily older document.
 *    `fresherCoherentSelection` therefore withholds staleness rather than ranking
 *    it. Note the field is compared as an INSTANT and not as a string, which is
 *    what keeps two spellings of one moment equal: see `rankOf`.
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
 *
 * DEPTH-1, AND THE ONE BOUNDARY OF THIS RULE THAT IS A CHOICE RATHER THAN A
 * CONSEQUENCE. Only a selected document's OWN direct sources are compared, because
 * `resolveDerivation` reads only those ("Depth-1 by construction: only the
 * document's own direct sources are read, never a source's sources" —
 * api/derivation.ts). So a crossing reachable only transitively is NOT reported and
 * reads `coherent`: a row holding PRD 2 beside a PR/FAQ whose only source is a
 * research report that referenced PRD 1 crosses generations two hops out and is
 * called coherent here. The chain is an ordinary product path, not a contrivance —
 * research/research_step_handler.py:198 records a selected PRD on a research report
 * as ROLE_REFERENCE, and jobs/document_generator/handler.py:176 records research
 * documents on a generated PR/FAQ as ROLE_REFERENCE.
 *
 * DELIBERATE, AND TRAVERSING WOULD BE WORSE — measured, not assumed. Walk the
 * sources transitively and the row that goes grey is the ORDINARY one: regenerating
 * a project produces research grounded in the previous PRD and then a new PRD and a
 * new PR/FAQ both generated from that research, so on the perfectly coherent
 * newest-of-each row {PRD 2, PR/FAQ 2} each document reaches PRD 1 at hop two — a
 * type the row holds another copy of. A transitive rule reports that row as crossing
 * generations, which is the "grey for everybody" failure the file docstring rejects
 * `coherent`-by-proven-edge for, arrived at from the other direction. Traversal also
 * needs cycle handling `resolveDerivation` deliberately does not have (its own
 * docstring notes a cyclic chain is inert precisely BECAUSE there is no traversal to
 * loop), and no control is gated on the state either way.
 *
 * THE LIMIT REACHES THE STALENESS ADVISORY TOO, which is the consequence worth
 * following: `fresherCoherentSelection`'s candidate check calls this rule, so a
 * candidate that crosses generations only transitively is ADVISED rather than
 * refused. That is stated where it is load-bearing — at that condition, and at the
 * call — and it is why the advisory's copy claims only what this depth verifies.
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

/** The rank of a document whose `created_at` names no instant at all. */
const NO_INSTANT = Number.NEGATIVE_INFINITY

/**
 * THE GRAMMAR this module will read a `created_at` by: an ISO-8601 calendar date,
 * optionally a time after a `T` or a space, optionally a zone designator (`Z` or
 * `±hh[:mm]`). Three patterns and a separator rather than one expression, because
 * one was past `sonarjs/regex-complexity` — and because the date, the clock and the
 * zone are three questions with three different answers below.
 *
 * AN ALLOW-LIST, and that direction is the whole point — the alternative, asking
 * `Date.parse` what a value means and repairing the shapes known to be ambiguous,
 * cannot be finished. `Date.parse` accepts implementation-defined spellings beyond
 * the one grammar ECMA-262 specifies, and reads EVERY zone-less one as the
 * runtime's local time: '2025/01/01 09:00:00' and 'January 1, 2025 09:00:00' both
 * parse, and both order differently for a reviewer in Tokyo than for one in London.
 * A pattern naming the shapes to REPAIR leaves every shape nobody thought of
 * reader-dependent; a pattern naming the shapes to READ leaves them `NO_INSTANT`,
 * which withholds. So an unrecognised spelling silences one row's staleness instead
 * of answering it differently per reader.
 *
 * The forms accepted are exactly the ones a stored `created_at` plausibly takes:
 * what the generators write (`datetime.now(timezone.utc).isoformat()`, so
 * '2025-01-01T09:00:00.123456+00:00'), the `Z` spelling of it, the date-only form,
 * and the space-separated form an import is as likely to carry as a 'T'. Seconds,
 * fractional seconds and the designator are each optional; the fraction may be any
 * length, since Python writes microseconds where ECMA-262's own grammar stops at
 * milliseconds.
 */
const READABLE_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The clock part, matched from the START only — whatever follows is the designator,
 * taken by length rather than by a trailing `(.*)`, which `sonarjs/slow-regex`
 * rightly reads as backtrackable.
 */
const READABLE_TIME = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/

/** A zone designator, matched against the whole of what followed the clock. */
const ZONE_DESIGNATOR = /^(?:Z|[+-]\d{2}:?\d{2}|[+-]\d{2})$/

/** What may stand between the date and the time — ISO's 'T', or an import's space. */
const DATE_TIME_SEPARATOR = /[T ]/

/**
 * Minutes east of UTC named by a designator, or null when it names none — which is
 * NOT the same as naming zero. '' (no designator at all) is zero, because a zone-less
 * time is read as UTC; anything else unrecognised is null, so the value it came from
 * names no instant rather than quietly becoming a UTC one.
 */
function offsetMinutes(designator: string): number | null {
  if (designator === '' || designator === 'Z') return 0
  if (!ZONE_DESIGNATOR.test(designator)) return null
  const digits = designator.slice(1).replace(':', '')
  const hours = Number(digits.slice(0, 2))
  const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0
  // Out of range is unreadable, not a large offset: the shape check cannot reject
  // '+99:99', and treating it as 99 hours would move a document four days and let a
  // typo decide a staleness advisory. 14 is the largest real offset (Kiritimati),
  // which is also the extreme the timezone test spans.
  if (hours > 14 || minutes > 59) return null
  return (designator.startsWith('-') ? -1 : 1) * (hours * 60 + minutes)
}

/**
 * The date and clock of a `created_at`, re-spelled as the ONE form ECMA-262 pins to
 * UTC whatever the runtime's zone, plus the designator that was on it — or null when
 * the value is outside the grammar.
 *
 * Split from `instantOf` so each half stays one question: this one is "what did the
 * record say", and that one is "what instant is that".
 */
function timestampFields(createdAt: string): { readonly utc: string; readonly zone: string } | null {
  const [date, ...rest] = createdAt.split(DATE_TIME_SEPARATOR)
  if (rest.length > 1 || !READABLE_DATE.test(date ?? '')) return null
  // Date-only: midnight UTC, which is what `Date.parse` already answers for it.
  if (rest.length === 0) return { utc: `${date ?? ''}T00:00:00Z`, zone: '' }
  const afterDate = rest[0] ?? ''
  const clock = READABLE_TIME.exec(afterDate)
  if (clock === null) return null
  // Everything past the clock is the zone — including '' for a value that named
  // none, which `offsetMinutes` reads as UTC rather than as unrecognised.
  return { utc: `${date ?? ''}T${clock[0]}Z`, zone: afterDate.slice(clock[0].length) }
}

/**
 * The INSTANT a `created_at` names, or `NO_INSTANT` when it names none.
 *
 * AN INSTANT, not a string, and that is the whole of the difference between this and
 * the raw-string ordering next door in api/documentLineage.ts. Lexicographic order
 * equals instant order only while every `created_at` shares ONE shape, and nothing
 * enforces that: `create_document` takes the caller's body, `manual_import_handler`
 * writes `item.get('timestamp')` straight from imported data, and the frontend field
 * is `z.string().catch('')` with no shape check. One hand-created or imported
 * document is enough to mix an offset form ('2025-03-10T23:00:00-05:00' — 04:00Z on
 * the 11th) with a Z form ('2025-03-11T02:00:00+00:00' — 02:00Z, EARLIER), where the
 * string compare answers backwards and this module would advise re-scoring against
 * older evidence.
 *
 * READ FROM THE FIELDS RATHER THAN HANDED TO `Date.parse`, because `Date.parse`
 * cannot answer this question reader-independently. Per ECMA-262 it reads a
 * date-ONLY value ('2025-01-01') as UTC but a date-TIME with no designator
 * ('2025-01-01T09:00:00') as the *runtime's local* time — and its tolerance for
 * spellings outside that grammar ('2025/01/01 09:00:00') is implementation-defined
 * and local-time too. Either way two documents would order by up to ±14h of
 * whichever timezone the reviewer's browser happens to be in: the same project
 * prints `Superseded` for one reviewer and not for another off byte-identical
 * records, and can advise re-scoring against evidence that is strictly OLDER (a row
 * holding '2025-01-01T01:00:00' pointed at '2025-01-01', an hour earlier, under
 * TZ=Asia/Tokyo). Every other rule in this module answers a property of the DATA; an
 * answer that depends on who is looking is the one thing none of them may be. Doing
 * the arithmetic here also removes the last reliance on engine tolerance — the
 * space-separated form's parse was never spec-guaranteed even with a designator
 * appended.
 *
 * A ZONE-LESS TIME IS READ AS UTC, which is the right assumption rather than merely
 * a neutral one: every generator writes `datetime.now(timezone.utc).isoformat()`
 * (projects.py for a prd/prfaq, document_merger for a merge), so a value that
 * reached storage without a designator was almost certainly meant as UTC — and where
 * the guess is wrong it is wrong IDENTICALLY for every reader, which is what makes
 * it a guess about the record instead of about the browser.
 *
 * Anything the grammar does not cover names no instant, '' included, and so does an
 * out-of-range field the grammar admits but the calendar does not (month 13, hour
 * 25) — `Date.parse` refuses those, and the `NaN` arm carries them. An impossible
 * DAY ('2025-02-30') is the exception: it rolls forward to March 2 rather than
 * failing, which is what the engine does with the same value today and is not worth
 * a check of its own — the value is a fiction either way, and it rolls identically
 * for every reader, which is the property this function exists to hold. Every
 * decision that WOULD rest on no instant is withheld rather than guessed; see
 * `hasUnreadableTimestamp`. Resolution is the millisecond `Date` carries, so two
 * documents from one microsecond-precise `isoformat()` can tie — which `rankOf`'s id
 * component breaks for the purpose of CHOOSING a type's newest document, and which
 * `fresherCoherentSelection` answers by withholding staleness rather than by letting
 * an id decide that one document superseded another.
 */
function instantOf(createdAt: string): number {
  const fields = timestampFields(createdAt)
  if (fields === null) return NO_INSTANT
  const offset = offsetMinutes(fields.zone)
  // `Date.parse` still does the CALENDAR arithmetic — month lengths, leap years — on
  // a value forced to `Z`, so the only thing taken out of its hands is the zone, and
  // the reader's clock cannot enter the answer. Its `NaN` carries the fields the
  // grammar admits but the calendar does not (month 13, hour 25).
  const utc = Date.parse(fields.utc)
  if (offset === null || Number.isNaN(utc)) return NO_INSTANT
  return utc - offset * 60_000
}

/**
 * Newest-first rank of a document: the instant its `created_at` names, then
 * `document_id` to break a tie.
 *
 * THE SAME TWO FIELDS `ordinalByType` ranks a type by, and the same tie-break, but
 * NOT the same comparison — that module compares the raw strings, and the claim
 * that these are one rule was wrong. The divergence is deliberate and is about what
 * each answer drives: being wrong there misnumbers a "PRD 2 of 3" badge, while
 * being wrong here prints `Superseded` on a current row and asks a reviewer to
 * create a row and re-score a proposal against evidence that may be OLDER. That is
 * the same asymmetry `hasUnreadableTimestamp` argues from, one step further on: a
 * precedent about ordering does not carry to advising. Fixing `compareRank` too
 * would be right, and is a change to a rendered ordinal in another module rather
 * than part of this one.
 *
 * TWO QUESTIONS, AND THE TIE-BREAK ANSWERS ONLY ONE OF THEM. Both are asked of the
 * same two fields and they are not the same question:
 *
 *  * CHOOSING the newest document of a type (`newestOfType`) needs a TOTAL order, or
 *    the answer depends on the order a read happened to return the list in. A PRD and
 *    a PR/FAQ generated from one request share a timestamp (the defect
 *    `byNewestFirst`'s equal arm exists for), and two documents of ONE type can share
 *    one too — with nothing to break that tie, `reduce` keeps whichever came first
 *    and the same project answers differently per read. That is what the
 *    `document_id` component is for, and it is not decoration;
 *  * deciding whether that choice is an IMPROVEMENT (`fresherCoherentSelection`'s
 *    `fresher`/`regressed`) compares INSTANTS ALONE and does not use this function.
 *    An id is not evidence of recency: settling the freshness question on one
 *    reported a frozen row `Superseded` by a same-instant sibling whose id merely
 *    sorted higher, making `lineage.staleReason`'s "a newer version … exists" false.
 *    A tie there WITHHOLDS staleness, which is as order-independent as breaking it
 *    and is this module's standing answer for an input that cannot settle a question.
 *
 * Either way the tie is on the INSTANT and not on the string, so two spellings of one
 * moment ('09:00:00Z' and '11:00:00+03:00') tie as they should instead of the
 * later-looking text winning.
 *
 * NO DECISION RESTS ON A TIMESTAMP NAMING NO INSTANT. `NO_INSTANT` ranks below
 * every dated document — INCLUDING far older ones — so a "fresher" answer resting
 * on one would read "superseded by a document from 2020".
 * `fresherCoherentSelection` refuses the comparison before making it
 * (`hasUnreadableTimestamp`). `newestOfType` still ranks such a document, which is
 * the one safe use: last within its type, so it can only be chosen when the project
 * holds nothing else of that type — and that candidate is then refused by
 * `regressed`.
 */
function rankOf(document: SelectedDocument): readonly [number, string] {
  return [instantOf(document.createdAt), document.id]
}

/** Is `a` strictly newer than `b` under `rankOf`? */
function isNewer(a: readonly [number, string], b: readonly [number, string]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0]
  return a[1] > b[1]
}

/**
 * Does any of these documents carry a timestamp that names no instant?
 *
 * The staleness gate for `created_at`, exactly parallel to the type gate beside it,
 * and for a sharper reason: an unreadable timestamp does not merely fail to state an
 * expectation, it states the WRONG one. `displayString` collapses absent, null and
 * non-string into '', and `instantOf`'s grammar refuses that along with any spelling
 * this module will not read — all of which rank as `NO_INSTANT`, below every dated
 * document of the type. Ranked rather than refused, the row is told its evidence was
 * superseded by whichever document the project happens to hold, however old. A 2020
 * document "superseding" a row is not a near-miss; it is advice to go and score older
 * evidence.
 *
 * There IS a precedent for "no timestamp sorts oldest" — `_default_row_composition`
 * in projects_handler.py records that reasoning — but it picks a default composition
 * there, where being wrong costs a reviewer one un-tick. Here the same guess drives
 * a sentence asking somebody to create a row and re-score a proposal, so the
 * asymmetry argues the other way and this withholds instead.
 *
 * ASKED OF THE ROW'S OWN DOCUMENTS ONLY, and the candidate needs no gate of its own:
 * with the row's instants readable, a candidate naming none ranks below the document
 * the row holds of that type, so `regressed` withholds one line later.
 * That is stated here rather than enforced twice — see the comment at the comparison
 * — because a second gate would be a branch no input can reach. NOT asked of every
 * project document either: a date-less document that is not the newest of its type
 * simply loses to a dated sibling, and letting one unreadable record anywhere in a
 * project silence every row's staleness would trade this defect for a quieter one.
 */
function hasUnreadableTimestamp(documents: readonly SelectedDocument[]): boolean {
  return documents.some((entry) => instantOf(entry.createdAt) === NO_INSTANT)
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
 * The ids of a genuinely fresher combination for this selection — one that does not
 * itself cross generations — or null when there is none. The name says COHERENT and
 * the fifth condition below says which of the three states that excludes: the
 * contradictory one, and not the one that merely records nothing.
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
 *  * the row's OWN documents must each carry a `created_at` naming an instant — one
 *    that names none loses every comparison and would have the row superseded by
 *    an arbitrarily older document. Gated on the row's side alone, because that is
 *    all it takes: a candidate naming no instant then loses to the document the row
 *    holds of its type and `regressed` withholds anyway. See
 *    `hasUnreadableTimestamp`, which is where the asymmetry between "guess wrong
 *    about a default" and "guess wrong in an advisory" is argued;
 *  * every type must still resolve to a document of the project, so a candidate
 *    is a set of documents that exist rather than of ids;
 *  * the candidate must be STRICTLY NEWER BY INSTANT — at least one type answering a
 *    later instant, and none answering an earlier one. A candidate that merely differs
 *    is not fresher, and the identical candidate is the ordinary state of a frozen
 *    row that is perfectly current. Compared by instant ALONE, never by `rankOf`'s
 *    tuple: a same-instant document with a higher `document_id` is not a newer
 *    version of anything, and reporting one as such made the badge's own sentence
 *    false. See the comment at the comparison, and `rankOf`. The SAME rule decides
 *    the candidate's CONTENT: a type whose newest only ties keeps the document the
 *    row already holds, so `newestOfType`'s id tie-break cannot substitute a
 *    same-instant sibling into the combination a reviewer is asked to score;
 *  * the candidate must not itself CROSS GENERATIONS. "The newest of each type" is
 *    not automatically one generation: a project whose newest PR/FAQ was built
 *    from the previous PRD produces a newest-of-each candidate that crosses
 *    generations, and pointing a reviewer at it would trade a stale row for an
 *    incoherent one. This is the condition that makes the criterion "a REAL
 *    fresher coherent combination exists" rather than "something newer exists".
 *
 *    ONE OF THE THREE STATES WITHHOLDS, NOT TWO, and which ones is the whole of
 *    this condition's correctness. `crossGeneration` withholds, for the reason
 *    above: the candidate is positively contradictory, so advising it is advising
 *    a mistake. `absent` does NOT withhold — it is `recordsNoLineage`'s answer for
 *    a combination in which nothing records what it was built from, which is the
 *    ordinary state of every document created before the `derivation` field
 *    existed and of every hand-authored one. Requiring `coherent` here silenced
 *    staleness for the whole of exactly the population that has it: a project
 *    several generations into a PRD is precisely the project with superseded
 *    frozen rows, and a deployment old enough to hold one is a deployment whose
 *    early documents predate lineage. It also made the answer turn on the wrong
 *    record — a row that recorded nothing WAS reported stale as soon as the
 *    candidate happened to record something, so the same row's verdict moved with
 *    a property of the newer document rather than with whether anything had been
 *    superseded.
 *
 *    Nothing about an `absent` candidate makes the advice less true: the
 *    arithmetic above reads only `document_type` and `created_at`, both of which a
 *    document with no derivation still carries, and the module's standing reading
 *    of `absent` is weaker EVIDENCE rather than a withheld outcome (see the file
 *    docstring, and `LineageState`, which calls it "the ordinary answer for a
 *    hand-authored document … rather than a fault"). Withholding on it would be
 *    the one place in this module where absent lineage decides something.
 *
 *    THE CHECK IS DEPTH-1, INHERITED FROM `hasSupersededSource`, and this condition
 *    is the reason that limit is worth stating twice. It refuses a candidate whose
 *    newest PR/FAQ names the previous PRD DIRECTLY; it does not refuse one whose
 *    newest PR/FAQ names a research report that named the previous PRD, because no
 *    rule in this module reads a source's sources. So the row can be told it is
 *    superseded and pointed at a combination that descends, two hops out, from the
 *    generation it is being moved away from. Traversing is measurably the wrong
 *    repair — it greys the ordinary regenerated row, argued at
 *    `hasSupersededSource` — so the boundary is CLOSED IN THE COPY instead: the
 *    sentence this drives claims only "does not cross generations" in the sense this
 *    rule checks, and never that the fresher combination is coherent. Both the
 *    classifier shape and this advisory shape are pinned by cases, so the limit is
 *    asserted rather than described.
 *
 * ONLY ONE OF THE TWO `crossGeneration` REASONS WITHHOLDS, and the asymmetry is
 * deliberate rather than a gap in the guards above. `repeatedType` withholds because
 * a row already holding two generations of a type has no single "same expectations"
 * candidate to compare with: "the newest of each type the row holds" collapses its
 * two PRDs onto one, so the candidate would answer the SAME document twice for a
 * two-document row.
 *
 * TWO RULES REFUSE THAT ROW, WHICH IS WHY DELETING EITHER ALONE CHANGES NOTHING —
 * measured, and worth stating because it is the opposite of how the rest of this
 * function is built. The first condition's `repeatsAType` call short-circuits it
 * before any candidate is formed; and if that call were removed, the doubled
 * candidate `[prd_2, prd_2]` itself classifies `crossGeneration`/`repeatedType`
 * (measured), so the FIFTH condition refuses it anyway. Deleting `repeatsAType` here
 * is therefore a NOOP against the whole suite, and the early call earns its place by
 * saying so at the top rather than by being the only thing standing between a
 * repeated-type row and a nonsense candidate.
 *
 * `supersededSource` does NOT withhold, and must not: the arithmetic stays
 * well-defined — one readable type per document, one candidate per type — and the
 * candidate it produces is checked for crossing generations on its own account
 * below. A row holding `prd_2` and a PR/FAQ built from `prd_1` is therefore
 * reported stale, pointed at the newest PRD and the newest PR/FAQ, and that advice
 * is true: measured, that candidate classifies `coherent`/`oneChain` and is
 * genuinely newer, and the same Add-row repairs BOTH complaints at once — the row's
 * evidence is internally inconsistent AND out of date.
 *
 * SO A ROW CAN LEGITIMATELY SHOW BOTH BADGES, `Crosses generations` beside
 * `Superseded`, which is not a conflict to be resolved but the two axes the
 * presentation was split along on purpose: see `RowStaleBadge`'s "a SECOND badge
 * rather than a fourth lineage state", where the argument is that state is about
 * the combination and staleness is about the passage of time. Both directions are
 * pinned by their own case, because a future guard added here could flip either
 * with nothing red otherwise.
 */
export function fresherCoherentSelection(
  selection: readonly unknown[],
  projectDocuments: readonly unknown[],
): readonly string[] | null {
  const selected = selectionEntries(selection)
  // `repeatsAType` AND NOT `hasSupersededSource`, which is the one place the two
  // rules that both answer `crossGeneration` are treated differently — deliberately,
  // and argued in the docstring's last three paragraphs. A repeated type leaves no
  // single "same expectations" candidate to form; a superseded source leaves the
  // arithmetic intact, and the candidate it produces is checked for crossing
  // generations on its own account below. So a `supersededSource` row CAN be
  // reported stale and show both badges at once.
  //
  // A SHORT-CIRCUIT RATHER THAN THE ONLY GUARD: the doubled candidate a repeated-type
  // row would produce classifies `repeatedType` itself, so the fifth condition
  // refuses it even without this call — deleting this call alone is a measured noop.
  // What is NOT redundant is the direction each reason takes, and both are pinned by
  // their own case, so widening this guard to every `crossGeneration` row cannot
  // silence the `supersededSource` advisory quietly.
  if (selected.length === 0 || repeatsAType(selected)) return null
  // A type nobody can read states no expectation — see the docstring's first
  // condition. Left in, `newestOfType(available, '')` would answer the project's
  // newest type-less record for it, which is a comparison between two documents
  // neither of which was shown to be of the same kind.
  if (selected.some((held) => held.type === '')) return null
  // A timestamp naming no instant states the WRONG expectation rather than none: it
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
  const newest = candidate.flatMap((entry) => (entry === null ? [] : [entry]))
  // A TIE KEEPS THE DOCUMENT THE ROW ALREADY HOLDS, which is the other half of "an id
  // is not evidence of recency" — the half about WHAT is advised rather than WHETHER
  // anything is. `newestOfType` breaks a same-instant tie on `document_id` and must:
  // choosing a type's newest document needs a total order, or the answer depends on
  // the order a read returned the list in. But once ANY type is genuinely newer,
  // `fresher` is satisfied and every OTHER type is resolved by that same tie-break —
  // so a type with nothing newer could be swapped for a same-instant sibling the row
  // does not hold, purely because its id sorts higher. That is the combination a
  // reviewer would be asked to score, so it must contain no document nobody showed to
  // be newer: `fresherDocumentIds`' own contract is that a type with nothing newer
  // resolves to the id the row ALREADY holds.
  //
  // A no-op whenever a type is genuinely newer (the instants differ, so nothing is
  // substituted), and restricted to a held document the project read actually carries,
  // so the coherence check below still sees a full set of records — a held id the
  // project does not carry would drop out of `records` and let a crossing candidate
  // pass on a shortened set.
  //
  // A CONSEQUENCE WORTH STATING, because it decides what any test of the verdict below
  // can observe: where this substitutes, `chosen[index]` IS `selected[index]`, so the
  // freshness comparison is asked about ONE document — and no two rules can disagree
  // about a document compared with itself. The instant-only verdict is therefore
  // observable only where the substitution is DECLINED, which is a held document the
  // project read is missing. That single input is what the case "withholds staleness on
  // a tie the project read does not carry the held document for" covers, and the reason
  // the ordinary tie case cannot: measured, restoring `isNewer(rankOf(...))` on the two
  // verdict lines leaves that case, and every other, green.
  const chosen = newest.map((entry, index) => {
    const held = selected[index]
    const tied = instantOf(entry.createdAt) === instantOf(held.createdAt)
    return tied && byId.has(held.id) ? held : entry
  })
  // NO SECOND GATE FOR THE CANDIDATE'S timestamps, and that is a proof rather than an
  // omission: the row's own name instants by the check above, so a candidate naming
  // none is `NO_INSTANT` against a real instant on the document the row holds of that
  // type — `regressed` below then returns null. A gate here would be a branch no
  // input can reach, which is worse than the sentence explaining why. This is the
  // accurate statement of the rule; `hasUnreadableTimestamp` and the condition list
  // above both point here rather than claiming a second call site.
  //
  // AND THE TIE-PREFERENCE ABOVE CANNOT WEAKEN THAT PROOF, which needs saying because
  // the proof reads `chosen[index]` as `newestOfType`'s answer and the substitution is
  // exactly what can make it something else. It cannot on THIS path: the substitution
  // asks `instantOf(entry.createdAt) === instantOf(held.createdAt)`, and a candidate
  // naming no instant answers `NO_INSTANT` against the real instant
  // `hasUnreadableTimestamp` has already guaranteed on the held document — so `tied` is
  // false, nothing is substituted, `chosen[index]` IS `newestOfType`'s answer, and
  // `regressed` fires as described. The proof therefore stands on the substitution's
  // own condition rather than on the substitution not existing.
  //
  // STRICTLY NEWER, which is also what answers the commonest case — a frozen row
  // already holding the newest of each type. That row's candidate IS its own
  // selection, so nothing is newer and `fresher` is false; an `every(id === id)`
  // early return above this was the same question asked twice, and a second spelling
  // of one rule is where the two come to disagree. `regressed` is the other half: no
  // type may answer something OLDER than the row holds, or a sideways move would read
  // as an improvement.
  //
  // THE INSTANT ALONE, never `rankOf`'s tuple, and that is the whole of what an id
  // may and may not decide here. `rankOf`+`isNewer` fall through to `document_id`,
  // which `newestOfType` needs — a total order, or "the newest PRD" depends on the
  // order a read returned the list in. Used for THIS question the same fall-through
  // reported a frozen row `Superseded` by a same-instant sibling whose id merely
  // sorted higher: `lineage.staleReason` then opened "A newer version of at least
  // one document type on this row exists" when none did, and `lineage.staleAction`
  // asked a reviewer to create a row and re-score against a combination that was
  // not fresher, only differently named. Three shapes produce the tie — two documents
  // from one `isoformat()` batch collapsing to `Date`'s millisecond, two spellings of
  // one moment (which is exactly what the instant comparison exists to make equal),
  // and any two date-only values from one day. A tie WITHHOLDS, which is as
  // order-independent as breaking it and is the module's standing answer for an
  // input that cannot settle a question (see `hasUnreadableTimestamp` and the type
  // gates): an id is not evidence of recency.
  //
  // ONE OF THOSE TIES ACTUALLY REACHES THIS COMPARISON, and it is worth naming which,
  // because otherwise the rule reads as covering three inputs it no longer sees. The
  // tie-preference above substitutes the held document for a tied newest, so for every
  // tie the project read carries the held document for, `chosen[index]` and
  // `selected[index]` are the SAME document and both spellings of the comparison agree
  // trivially. What is left is a tie whose held document the read is missing, where the
  // substitution is declined — the sole input under which this line and
  // `isNewer(rankOf(...))` differ, and the one the regression case uses.
  const fresher = chosen.some(
    (entry, index) => instantOf(entry.createdAt) > instantOf(selected[index].createdAt),
  )
  const regressed = chosen.some(
    (entry, index) => instantOf(selected[index].createdAt) > instantOf(entry.createdAt),
  )
  if (!fresher || regressed) return null
  const records = chosen.flatMap((entry) => {
    const record = byId.get(entry.id)
    return record === undefined ? [] : [record]
  })
  // A candidate that CROSSES GENERATIONS is refused; one that merely records no
  // lineage is not. `!== 'coherent'` here refused `absent` too, which silenced
  // staleness for every frozen row on a pre-`derivation` project — see the fifth
  // condition in the docstring for why only the contradictory state may withhold.
  //
  // AS DEEP AS `hasSupersededSource` READS, AND NO DEEPER, which bounds what this
  // refusal can promise: a candidate whose newest PR/FAQ names the previous PRD
  // directly is refused, one whose PR/FAQ names a research report that named it is
  // not. `lineage.staleReason` is worded to that limit rather than to the stronger
  // claim — see the fifth condition, and `hasSupersededSource` for why traversing
  // would grey the ordinary regenerated row instead of fixing this.
  if (classifySelectionLineage(records, projectDocuments).state === 'crossGeneration') return null
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
 *
 * AND ONLY OF A ROW WHOSE STORED COMPOSITION FULLY RESOLVED. `composition_truncated`
 * says a stored `document_id` named a document the project read no longer holds, so
 * `documents` is a strict SUBSET of what the ballots were cast on. Every other
 * "cannot settle it" input in this module withholds rather than guesses
 * (`hasUnreadableTimestamp`, both type gates); this is that case one axis up, about
 * the selection itself rather than a field on one of its members.
 *
 * STALENESS WITHHOLDS, THE CLASSIFICATION DOES NOT, and the asymmetry is the whole
 * of the decision:
 *
 *  * the classification describes THE DOCUMENTS ON SCREEN. A row rendering one
 *    document is honestly described by what that one document records, and saying
 *    nothing would replace a true statement about visible evidence with silence;
 *  * the advisory NAMES A COMBINATION to go and score. Derived from a subset it
 *    silently omits a type the ballots covered: a row stored as {prd, prfaq} that
 *    lost its PRD advises a PR/FAQ-ONLY combination, so a reviewer is told to
 *    re-score a proposal on strictly less evidence than the row they are replacing.
 *    That is the mirror image of the missing-optional-document boundary in
 *    `fresherCoherentSelection` — which protects a row that never held a PRD, and
 *    would otherwise leave a row that HELD one and lost it unprotected.
 *
 * The freeze is exactly why this cannot be left to fix itself: a frozen row cannot be
 * recomposed, so it is the one row that will keep the truncated composition. And
 * `collectRows` keeps such a row on screen deliberately (it drops a row only when NOT
 * ONE id resolves), which is what makes this reachable rather than theoretical.
 */
export function rowLineageOf(
  row: {
    readonly is_frozen: boolean
    readonly documents: readonly unknown[]
    /**
     * Did a stored `document_id` fail to resolve against the project read?
     *
     * OPTIONAL, defaulting to "no", so the many callers holding a selection with no
     * stored id list behind it — every case at this seam, and any future one — say
     * nothing rather than being made to assert a negative. `collectRows` is the one
     * caller that can know, because it is the one that does the resolving.
     */
    readonly composition_truncated?: boolean
  },
  projectDocuments: readonly unknown[],
): RowLineage {
  const lineage = classifySelectionLineage(row.documents, projectDocuments)
  const fresher = row.is_frozen && row.composition_truncated !== true
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
 * emerald-800 #006045 on emerald-100 #d0fae5 is 6.70:1, amber-800 #973c00 on
 * amber-100 #fef3c6 is 6.36:1, gray-600 #4a5565 on gray-100 #f3f4f6 is 6.87:1.
 * (`RowStaleBadge`'s orange pair carries its own figure, beside the classes it
 * uses.)
 *
 * EACH HEX RECOMPUTED FROM `node_modules/tailwindcss/theme.css` rather than
 * carried over, because two of these were wrong when written and one of them
 * was wrong in the way that matters: `#016630`/`#dbfce7` are **green**-800/-100,
 * a different palette entry from the `emerald` the `color` below actually names,
 * so the figure documented a colour this file does not use. v4 states these as
 * OKLCH, so a hex quoted here is a conversion and not a value to be found in the
 * stylesheet — the same trap `BAND_STYLE`'s "that was the v3 hex, and wrong"
 * note records one module over. Every pair still clears AA comfortably; only the
 * evidence needed correcting.
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
