/**
 * @fileoverview The TEAM half of the scores read: parsing the aggregates and naming why they are absent.
 * @module pages/Prioritization/teamRead
 */

import { z } from 'zod'
import type {
  PrioritizationAggregate,
} from '../../api/projectTypes'

/**
 * The team view of one document, validated at the query boundary.
 *
 * `GET /projects/prioritization` returns these beside the caller's own `scores`,
 * and this page now leads with them: the resting row shows what the group thinks,
 * the caller's own sliders sit one level in. The field is optional on the wire
 * (a deployment predating it sends no `aggregates` at all), so absence has to
 * read as "no team data yet", never as an error.
 *
 * Lenient in the same spirit as `formLinkUtils.LinkedFormSchema`: an axis or a
 * spread that cannot be read degrades to 0 rather than taking the row off the page,
 * because a partial aggregate is still worth showing. A number merely OUT OF RANGE
 * is CLAMPED into [0, 5] instead — see `TEAM_AXIS`, which is where the difference
 * between "unreadable" and "too large" is made.
 *
 * `reviewer_count` is the exception and carries NO fallback: it is the field that
 * says somebody voted, and an invented 1 would present a row nobody scored as a
 * scored one. A row without a usable count is dropped, which lands it in exactly
 * the state the backend uses for "nobody scored this" — absent. The bound is
 * `min(1)` for the same reason: `_aggregate_scores` omits a document with no
 * votes rather than emitting a zero-count row, so a zero count is not a row this
 * page can render honestly.
 *
 * The per-axis leniency has one floor, enforced by `parseAggregate` rather than by
 * the schema: a row where NOT ONE axis is a readable number is dropped too. Left
 * to `.catch(0)` alone, `{ reviewer_count: 2 }` would parse into an all-zeros
 * aggregate and render "0.0, Reviewers 2" — the mirror of the case `min(1)`
 * exists to prevent, inventing a score for a row that carries none and dressing it
 * with a real count. A row with at least one readable axis is still shown with the
 * rest degraded, because the backend itself reports 0.0 for an axis nobody scored,
 * so a zeroed axis beside a scored one is real data rather than a parse failure.
 *
 * That floor is about READABILITY, never about range, which is why the two are
 * separate schemas. `TEAM_AXIS` reads the value; `READABLE_AXIS` only asks whether
 * a number was sent at all. Testing the floor against a BOUNDED schema conflated
 * the two: four means of 6 with `reviewer_count: 4` were dropped and the row read
 * "Not scored yet" — a document four reviewers had voted on presented as one nobody
 * had opened — while the same row with ONE axis in range was kept with the other
 * three at 0. Same data quality, opposite outcome, decided by whether one axis
 * happened to land inside the bound.
 */
/**
 * One team mean, as this page can render it: a number, clamped to the slider's scale.
 *
 * CLAMPED rather than caught to 0, because the two answer different questions and
 * only clamping keeps the row derived from data somebody actually cast. Catching an
 * out-of-range number to 0 combined with the readability floor below to produce the
 * exact row the docstring above forbids: `{all axes 6, reviewer_count: 3}` cleared
 * the floor (each axis IS a number) and then rendered `0.0 / 0.0 / 0.0`, "Reviewers
 * 3", banded "Low Priority", with a "Spread 2.0" badge inviting the reader to read
 * notes about a disagreement over numbers the parse had thrown away — and it sorted
 * BELOW a row the team genuinely rated 1 across the board. Clamping answers `5.0`
 * and "High Priority" instead, from the data as sent.
 *
 * The same line the backend draws on the way IN, for the same stated reason:
 * `_is_clampable_number` is "CLAMP A NUMBER, REFUSE A NON-NUMBER", because `99` and
 * `-4` plainly mean a value the slider range can hold while `'high'` has none to
 * bound — so a 0 substituted there is INVENTED and, once stored, "indistinguishable
 * from a deliberate lowest score". That is this defect exactly, on the read side.
 * `.catch(0)` is therefore reached only by a value that is not a number at all, which
 * expresses no position on the scale and so cannot be clamped onto it.
 */
const TEAM_AXIS = z.number()
  .transform((mean) => Math.min(5, Math.max(0, mean)))
  .catch(0)

/**
 * Was a number sent for this axis at all — the question the drop rule asks.
 *
 * Deliberately unbounded. Range is `TEAM_AXIS`' business and is handled by clamping;
 * this answers "did the row say anything numeric here", which is what distinguishes a
 * row asserting a score nobody cast from one whose numbers merely need clamping.
 * Still rejects `NaN` and `Infinity`, which `z.number()` refuses, and bools and
 * strings, which express no slider position (the same reading the backend's
 * `_readable_axis` takes).
 */
export const READABLE_AXIS = z.number()

const TeamAggregateSchema = z.looseObject({
  impact: TEAM_AXIS,
  time_to_market: TEAM_AXIS,
  confidence: TEAM_AXIS,
  strategic_fit: TEAM_AXIS,
  reviewer_count: z.number().int().min(1),
  // In the same unit as `calculatePriorityScore`, so it is readable as "how far
  // apart two reviewers were, in slider notches" — and clamped to that scale for the
  // same reason an axis is: a spread of 9 notches on a 0–5 scale is unreadable as
  // sent but still says the reviewers were as far apart as they can be.
  score_spread: TEAM_AXIS,
})

/** The four fields a row must be able to say SOMETHING about to be worth showing. */
export const AXIS_FIELDS = ['impact', 'time_to_market', 'confidence', 'strategic_fit'] as const

/**
 * One row of the team view, or `null` when it cannot be read.
 *
 * The return type is the DECLARED wire type, not `z.infer` of the schema above:
 * the two are then checked against each other by `tsc` at this one line, so a
 * schema that stops producing what `PrioritizationAggregate` promises is a compile
 * error rather than a lenient parse of a shape nothing else in the app agrees
 * with.
 *
 * The axis check is made against the RAW input, after the lenient parse, because
 * `TEAM_AXIS`' `.catch(0)` has by then erased the difference between "the team
 * scored this 0" and "this field was unreadable". A row with no readable axis at all
 * asserts a score nobody cast, so it is dropped — the same argument as
 * `reviewer_count`, and it lands the row in the same "nobody scored this" state the
 * page already renders honestly.
 *
 * Against `READABLE_AXIS`, not `TEAM_AXIS`: the rule is "did the row say anything
 * numeric", and an out-of-range mean plainly did. Dropping it too made a row four
 * reviewers voted on read as one nobody had opened; a row that clears the floor on a
 * merely-out-of-range axis is honest because `TEAM_AXIS` clamps rather than zeroes
 * it, so what the row shows is still the data as sent.
 */
function parseAggregate(value: unknown): PrioritizationAggregate | null {
  const parsed = TeamAggregateSchema.safeParse(value)
  if (!parsed.success) return null
  const raw = z.record(z.string(), z.unknown()).safeParse(value)
  if (!raw.success) return null
  const hasReadableAxis = AXIS_FIELDS.some((axis) => READABLE_AXIS.safeParse(raw.data[axis]).success)
  return hasReadableAxis ? parsed.data : null
}

/**
 * Why the team view is not a map: the read is still running, or it failed.
 *
 * Two states rather than one, because they license different words. "We could not
 * read this" is a settled outcome the reader can act on by reloading; "we are still
 * reading" is a claim about nothing at all, and will be replaced in a moment. What
 * they share is the only thing that matters to every consumer: neither says anything
 * about how anyone scored any document.
 */
export type TeamReadState = 'loading' | 'unavailable'

/**
 * What to call each read state, for the surfaces that name one without a document.
 *
 * A `Record` over the union rather than a ternary, for the reason `unscoredLabel`'s
 * switch keeps its unreachable arm: a ternary silently folds any state it does not
 * name into its else branch, so a third read state would be announced as "could not
 * be read" and compile. A missing key here is a type error instead.
 *
 * Namespace-QUALIFIED, like `BAND_STYLE`: `scripts/i18n-check.mjs` only collects a
 * data-held key that carries a namespace, and an unprefixed one becomes a deletion
 * candidate — which then renders the raw key path to users.
 */
export const READ_STATE_I18N_KEY: Record<TeamReadState, `prioritization:${string}`> = {
  loading: 'prioritization:team.loading',
  unavailable: 'prioritization:team.unavailable',
}

/**
 * A row the response named but nothing in it could be read.
 *
 * Kept under its own key rather than dropped, because the two are different statements: an
 * ABSENT key is "nobody has voted on this document", which the backend says by omitting it,
 * and this is "the server named this document and we could not read what it said". Dropping
 * turned the second into the first — a scored document presented as unscored.
 */
export const UNREADABLE_ROW = 'unreadable'

/** One document's team view as the wire gave it: readable, or named but unreadable. */
export type TeamAggregateRow = PrioritizationAggregate | typeof UNREADABLE_ROW

/**
 * The team view of the whole backlog, or why it is absent.
 *
 * THREE different absences, kept apart by the type. An empty map is "the read
 * arrived and nobody has scored anything", which every row may honestly state.
 * `'unavailable'` and `'loading'` are "we do not know what the team said", which no
 * row may state as an absence of votes: the endpoint raises rather than answering an
 * empty map precisely so the two stop looking alike, and reading either as an empty
 * map would undo that on screen — every row asserting "no reviewer has scored this
 * yet" over data that exists on the server, and the stats cards counting the whole
 * backlog as unscored.
 *
 * `'loading'` is here rather than folded into `'unavailable'` because the page can
 * tell them apart and a reader can too: the query's own `isPending` is the source,
 * and the row that says "still loading" is not the row that says "reload me".
 * Neither is representable as `undefined`, which is exactly why this is not derived
 * from `data` alone — that is undefined while a read is in flight, when it has
 * failed, and before it is enabled.
 */
export type TeamAggregates = Record<string, TeamAggregateRow> | TeamReadState

/**
 * The team view, or the reason there is none, from the query's own three signals.
 *
 * Here rather than inline in the component so the mapping is testable without
 * rendering a page, and so the precedence is stated once: A MAP OUTRANKS BOTH READ
 * STATES, and between the two states failure outranks pending.
 *
 * A map first, because `failed` is the query's `isError`, and that is true of a
 * failed REFETCH just as much as of a failed first read — while TanStack Query goes
 * on holding the last successful response. Answering `'unavailable'` there threw away
 * team means the page was already showing: every row dropped to "Team score
 * unavailable", the stats cards dashed, the score sort stopped ordering and Save
 * disabled. And the refetch after a successful save is exactly that path, since the
 * save invalidates this query — so the reader's reward for casting a ballot was the
 * team column vanishing on one unlucky retry. "We could not read this" is a weaker
 * statement than the data warrants when the previous answer is in hand: the retained
 * map is what the reader saw a moment ago, and the error panel above the list, keyed
 * on `isError` directly, is what says the latest read failed.
 *
 * It also puts the two halves of one query back in step. `scores` reads
 * `data?.scores ?? {}` and so keeps the caller's own ballots through a failed
 * refetch; the team half now survives it too, rather than one object off one query
 * having two outcomes.
 *
 * The states answer only when there is NO map to prefer, which is why the caller cannot
 * pass `data` alone: `aggregates` is `undefined` while the read is in flight and when it
 * failed with nothing cached, and neither says anything about any document.
 *
 * The trailing arm is `'unavailable'`, not an empty map. It used to be `{}` and was then
 * unreachable from the page, because `normalizeAggregates` mapped both an absent field and
 * an unreadable one to `{}` before this was called. Now the normalizer keeps those apart —
 * absent still answers an empty map, unreadable answers `undefined` — so this arm is
 * reached by exactly one state: a response ARRIVED and its team half could not be read.
 * "We could not find out" is the honest answer there, and an empty map would be the page's
 * assertion that nobody has voted on anything.
 */
export function teamAggregatesOf(read: {
  readonly failed: boolean
  readonly pending: boolean
  /**
   * What the response gave for the team half: a map — empty when the field was absent,
   * which is the pre-#333 "no team data yet" case — or `undefined`, which now means
   * "nothing readable", whether because the read has not delivered or because
   * `normalizeAggregates` refused what it carried.
   */
  readonly aggregates?: Record<string, TeamAggregateRow>
}): TeamAggregates {
  return read.aggregates ?? readStateOf(read) ?? 'unavailable'
}

/**
 * Why there is no map to read, or `null` when the caller has one to prefer.
 *
 * FAILURE outranks pending, because a query that has failed and is retrying is
 * pending again, and "reload the page" is the more useful of the two things to say
 * about it. This only decides the no-map case; see `teamAggregatesOf`.
 */
function readStateOf(read: {
  readonly failed: boolean
  readonly pending: boolean
}): TeamReadState | null {
  if (read.failed) return 'unavailable'
  return read.pending ? 'loading' : null
}

/**
 * Did the team read deliver a map — the binary question layered on the four states.
 *
 * One exported predicate rather than `typeof aggregates === 'string'` at each call
 * site, for the reason `reviewersDisagreed` and `roundToDisplay` exist: the union
 * makes the FOUR-state question impossible to get wrong, but "is there a map at all"
 * escaped that and was spelled three times across two files. It is also the least
 * self-describing form of the question — a reader at the Save button has to know that
 * the only strings in the union are read states to see why the button is disabled.
 *
 * A type PREDICATE, so a caller that has asked can then read the map as a map. The
 * union's string members are exactly `TeamReadState`, which is what makes the
 * `typeof` test exhaustive rather than incidental.
 */
export const teamReadDelivered = (
  aggregates: TeamAggregates,
): aggregates is Record<string, TeamAggregateRow> => typeof aggregates !== 'string'

/**
 * Why the surfaces that aggregate OVER rows cannot count this read, or `null` when
 * they can.
 *
 * The one spelling of a question that was being asked as "did a map arrive"
 * (`teamReadDelivered`) by the stats cards and as a bare `!== 'unavailable'` by the
 * sort hint — and both went wrong the same way when per-row marking landed: a
 * response whose EVERY named row is unreadable now parses to a map, so `delivered`
 * is true, while the response says exactly as little about the backlog as an
 * unreadable container. Counting it produced three confident zeros — the claim the
 * cards' own docstring forbids, since a zero asserts "none of these is high
 * priority" about documents no read has described — and the hint went on
 * attributing the sort to numbers that do not exist.
 *
 * So the aggregating surfaces ask THIS, and the map-shaped failure answers
 * `'unavailable'` exactly as the container-shaped one does — same fault, same
 * sentence. The rows themselves never ask it: per-row honesty is `getTeamView`'s,
 * and one bad row must not decide what the page says about its siblings.
 *
 * An EMPTY map is countable, deliberately: the server listing no scored documents
 * is a real answer, and zeros are then honest — nobody has voted on anything, and
 * the whole backlog genuinely is "Not Scored". Only a map that NAMES documents and
 * can read none of them has failed to answer.
 */
export function uncountableTeamRead(aggregates: TeamAggregates): TeamReadState | null {
  if (!teamReadDelivered(aggregates)) return aggregates
  const rows = Object.values(aggregates)
  return rows.length > 0 && rows.every((row) => row === UNREADABLE_ROW) ? 'unavailable' : null
}

/**
 * Can the three score sorts order the list by the team's numbers — now, or, for the
 * states that clear on their own, in a moment?
 *
 * The predicate behind the permanently-visible hint under the sort buttons, which
 * claims those buttons order the list by the team's numbers. That claim has to be
 * withdrawn in the states where nothing can order anything and no amount of waiting
 * fixes it, or the page is attributing an effect the reader can click for and not
 * get — and `uncountableTeamRead` is precisely the list of those states, so this is
 * spelled off it rather than re-deriving which shapes of the union count.
 *
 * `'loading'` is uncountable but keeps the hint: it will be a map in a moment, and a
 * line that blinks out and back is worse than one that waits. An EMPTY map keeps it
 * too — the buttons cannot reorder anything yet, but nobody voting is not a failure,
 * the state fixes itself with the first ballot, and the hint is most use before the
 * reader clicks.
 */
export function teamOrderingAvailable(aggregates: TeamAggregates): boolean {
  return uncountableTeamRead(aggregates) !== 'unavailable'
}

/**
 * An OPTIONAL map field of the scores response, read three ways.
 *
 * ABSENT answers `{}`: a deployment predating the field sends none at all, and "nothing
 * here yet" is an honest reading. PRESENT BUT NOT A MAP — `null`, a string, a number, an
 * array — answers `undefined`, for the caller to report as unreadable rather than as
 * empty. A readable map is handed back for the caller's own per-row rule. Shared by
 * `normalizeAggregates` and `normalizeRows`, which make exactly this distinction before
 * looking at a single row; `normalizeScores` does not take the absent branch, because a
 * response with no `scores` field is one the page refuses to save over.
 */
export function optionalFieldAsMap(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return {}
  const asMap = z.record(z.string(), z.unknown()).safeParse(raw)
  return asMap.success ? asMap.data : undefined
}

/**
 * The team view per document, from whatever the wire actually sent.
 *
 * Never throws and never rejects the whole map over one bad ROW: this feeds a
 * `select`, so a throw here would turn a readable response into a failed query
 * and take the page's error panel with it. A row that cannot be read is dropped,
 * and a dropped row renders as unscored — the same state as a document nobody
 * has voted on, which is the honest reading when that one row is unusable.
 *
 * An unreadable CONTAINER answers `undefined`, because the alternative — an empty map — is
 * the page's assertion that nobody has voted on anything. An empty container still answers
 * `{}`: the server listing no scored documents is a real answer.
 *
 * An unreadable ROW keeps its key and answers `UNREADABLE_ROW`, so the document it names
 * renders as "we could not find out" rather than as "nobody voted". Dropping it read as the
 * latter — a scored document presented as unscored, the one claim this whole page exists to
 * prevent — and a rule that only noticed when EVERY row dropped made the same bad row
 * reported or silent depending on whether some unrelated document happened to parse. One
 * rule per row has no such discontinuity: all rows unreadable simply means every row says
 * so, which is the page-level outcome the special case was reaching for.
 *
 * A failed or in-flight READ is still not this function's to know: the query owns those,
 * and `teamAggregatesOf` folds them into `TeamAggregates`.
 */
export function normalizeAggregates(
  raw: unknown,
): Record<string, TeamAggregateRow> | undefined {
  // The FIELD BEING ABSENT is the one case that means "no team data yet": a deployment
  // predating `aggregates` sends none at all, and every row may honestly say nobody has
  // scored it. Anything else that is not a readable map — `null`, a string, a number, an
  // array — is a response we could not read, and answering `{}` there asserted that
  // NOBODY HAS VOTED ON ANY DOCUMENT, which is this page's strongest claim. That is the
  // same defect `normalizeScores` was changed to stop making on the other half of the
  // response, and the same argument: a declared type is a promise, not a proof.
  //
  // `undefined` is the answer for unreadable, and `teamAggregatesOf` turns it into
  // `'unavailable'`: this returns one type plus `undefined` rather than a union with a
  // read state in it, both because `sonarjs/function-return-type` refuses the union and
  // because naming a UI state is the query's job, not the parser's.
  const entries = optionalFieldAsMap(raw)
  if (entries === undefined) return undefined
  return Object.fromEntries(
    Object.entries(entries).map(([rowId, value]): [string, TeamAggregateRow] => (
      [rowId, parseAggregate(value) ?? UNREADABLE_ROW]
    )),
  )
}
