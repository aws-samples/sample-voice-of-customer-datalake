/**
 * @fileoverview Shared utilities for the prioritization feature.
 * @module pages/Prioritization/prioritizationUtils
 */

import { z } from 'zod'
import type {
  Project, ProjectDocument, PrioritizationScore, PrioritizationAggregate,
  PrioritizationBallotEdit,
} from '../../api/types'

export interface PRFAQWithProject extends ProjectDocument {
  project_id: string
  project_name: string
  // Latest prototype (if any) for the same project. Surfaced under the PR/FAQ
  // preview row so reviewers can see the demo without leaving the page.
  prototype?: ProjectDocument
}

export type SortField = 'priority_score' | 'impact' | 'time_to_market' | 'created_at' | 'title'
export type SortDirection = 'asc' | 'desc'

export const DEFAULT_SCORE: PrioritizationScore = {
  document_id: '',
  impact: 0,
  time_to_market: 3,
  confidence: 0,
  strategic_fit: 0,
  notes: '',
}

/**
 * The four axes the composite weighs — the shape `calculatePriorityScore` reads.
 *
 * Declared for what the function USES rather than as `PrioritizationScore`,
 * because two different things are now composited through it: one reviewer's
 * ballot (`PrioritizationScore`, which also carries `document_id` and `notes`)
 * and the team's per-axis means (`PrioritizationAggregate`, which carries
 * `reviewer_count` and `score_spread` instead). Both are structurally assignable
 * to this, so neither call site needs a cast — which ESLint forbids here anyway —
 * and the row's headline number and the sort order are computed by the same
 * function, which is what keeps them in agreement.
 */
export interface CompositeAxes {
  readonly impact: number
  readonly time_to_market: number
  readonly strategic_fit: number
  readonly confidence: number
}

/**
 * The composite score this page sorts by.
 *
 * These four weights are duplicated in `COMPOSITE_WEIGHTS` in the backend's
 * `projects_handler.py`, which uses them to report the SPREAD of the composite
 * score across reviewers. Re-weight here alone and that spread silently starts
 * describing a different unit than this column — so the pair is pinned by
 * `lambda/api/test/test_prioritization_weights_lockstep.py`, which fails rather
 * than letting the two drift.
 */
export const calculatePriorityScore = (score: CompositeAxes): number => {
  return (score.impact * 0.4) + (score.time_to_market * 0.3) + (score.strategic_fit * 0.2) + (score.confidence * 0.1)
}

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
const READABLE_AXIS = z.number()

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
const AXIS_FIELDS = ['impact', 'time_to_market', 'confidence', 'strategic_fit'] as const

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
export type TeamAggregates = Record<string, PrioritizationAggregate> | TeamReadState

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
  readonly aggregates?: Record<string, PrioritizationAggregate>
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
): aggregates is Record<string, PrioritizationAggregate> => typeof aggregates !== 'string'

/**
 * What one row can say about the team, in the four states it can be in.
 *
 * A union rather than `TeamScore | null` plus a boolean beside it, so a state cannot
 * be forgotten at a call site: every consumer either handles each one or fails to
 * compile. That is what made adding `'loading'` a widening of one type rather than
 * five parallel edits — `tsc` walked to every surface that had to decide.
 *
 * The distinction the page exists to keep: "the team rated this low", "nobody has
 * voted", "we could not find out" and "we have not finished looking" are four
 * different statements, and only the first two are about the document.
 */
export type TeamView =
  | {
    readonly kind: 'scored';
    readonly team: TeamScore
  }
  | { readonly kind: 'unscored' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'loading' }

/**
 * The `TeamScore` a view carries, or `null` when it carries none.
 *
 * For the two consumers that only ask about a score they can read — the spread
 * predicate and the numbers beside it. Every non-scored state answers `null`
 * because none has a spread: nobody voted, nobody could tell us, or we are still
 * asking.
 */
export const teamScoreOf = (view: TeamView): TeamScore | null => (
  view.kind === 'scored' ? view.team : null
)

/**
 * The team view per document, from whatever the wire actually sent.
 *
 * Never throws and never rejects the whole map over one bad ROW: this feeds a
 * `select`, so a throw here would turn a readable response into a failed query
 * and take the page's error panel with it. A row that cannot be read is dropped,
 * and a dropped row renders as unscored — the same state as a document nobody
 * has voted on, which is the honest reading when that one row is unusable.
 *
 * An unreadable CONTAINER is a different matter and answers `undefined`, because the
 * alternative — an empty map — is the page's assertion that nobody has voted on anything.
 * So does a non-empty container whose EVERY row was dropped: one bad row among readable
 * ones is honestly absent, but nothing readable at all is a fact about the response rather
 * than about the documents, and it composes back into exactly the claim the container check
 * refuses. An empty container still answers `{}` — the server listed no scored documents,
 * which is a real answer.
 *
 * A failed or in-flight READ is still not this function's to know: the query owns those,
 * and `teamAggregatesOf` folds them into `TeamAggregates`.
 */
export function normalizeAggregates(
  raw: unknown,
): Record<string, PrioritizationAggregate> | undefined {
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
  if (raw === undefined) return {}
  const asMap = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!asMap.success) return undefined
  const rows = Object.entries(asMap.data)
  const readable = Object.fromEntries(
    rows.flatMap(([documentId, value]): [string, PrioritizationAggregate][] => {
      const aggregate = parseAggregate(value)
      return aggregate ? [[documentId, aggregate]] : []
    }),
  )
  // EVERY row dropped from a non-empty container is a fact about the RESPONSE, not about
  // the documents — the same argument the container check above makes, reached through the
  // other door. Composing it back into `{}` would say "nobody has voted on any document" on
  // the strength of a payload nothing in it could be read. An empty container is different
  // and still answers `{}`: the server genuinely listed no scored documents.
  if (rows.length > 0 && Object.keys(readable).length === 0) return undefined
  return readable
}

/**
 * One axis of the CALLER'S OWN ballot: out of range clamps, unreadable degrades.
 *
 * The AXIS-level difference from `TEAM_AXIS`, which is the only difference left now that
 * both halves drop an unreadable row: `TEAM_AXIS` catches to 0, because 0 is a mean the
 * team could genuinely have, while this catches to the value an UNSET axis already shows
 * (`time_to_market` is 3, not 0). A slider that cannot be given the reviewer's stored
 * value should read as untouched rather than as a deliberate lowest score.
 */
const ownAxis = (fallback: number) => z.number()
  .transform((value) => Math.min(5, Math.max(0, value)))
  .catch(fallback)

// `z.object`, not `looseObject`: this is the shape the page ACCEPTS, and it reads exactly
// these five fields plus the key. Loose let unknown wire fields ride into every
// `PrioritizationScore` and on through `applyBallotEdits` — harmless while only
// `localEdits` are sent, but a boundary that keeps what it does not understand is not
// saying what it accepts. `TeamAggregateSchema` stays loose for the opposite reason: it is
// checked field-by-field against a raw row that the drop rule then re-reads.
const OwnBallotSchema = z.object({
  impact: ownAxis(DEFAULT_SCORE.impact),
  time_to_market: ownAxis(DEFAULT_SCORE.time_to_market),
  confidence: ownAxis(DEFAULT_SCORE.confidence),
  strategic_fit: ownAxis(DEFAULT_SCORE.strategic_fit),
  // NOT bounded to `MAX_NOTE_LENGTH`. Notes longer than the API now accepts exist in
  // stored data — the bound arrived after them — and truncating one here would silently
  // rewrite a reviewer's justification. `overLongNoteDocuments` is what refuses to SEND
  // one; reading it back is not the same act.
  notes: z.string().catch(''),
})

/** What the page knows about the caller's own ballots, resolved in one place. */
export interface OwnBallotRead {
  /** The ballots to render — empty when there are none to show. */
  readonly ballots: Record<string, PrioritizationScore>
  /** Are this reviewer's stored ballots actually in hand? The save's precondition. */
  readonly inHand: boolean
  /** Does the reader need telling why their own numbers are missing? */
  readonly needsPanel: boolean
}

/**
 * The caller's own half of the prioritization read, as the three consumers need it.
 *
 * Here rather than as three expressions in the component, because the three are ONE
 * question and were previously asked in two different ways: the save guard read the
 * caller's ballots while the panel's wording read the TEAM map, so a response with
 * readable aggregates and unreadable ballots said "there is no need to reload before
 * saving" beside a disabled Save. Resolving once makes that disagreement unrepresentable
 * rather than merely fixed, which is the same move `teamAggregatesOf` made for the team
 * half — and it keeps the page's own branch count inside the lint budget.
 *
 * Takes the three FACTS rather than the response object: a hand-written response shape
 * here would restate the wire one function after `selectPrioritization` went to the
 * trouble of deriving its own from the client, and deriving it here instead
 * (`Pick<ReturnType<typeof selectPrioritization>, 'scores'>`) would make this module
 * import the page that imports it.
 *
 * `needsPanel` covers BOTH ways the reader can be left without their numbers: the read
 * failed, or it succeeded carrying ballots that could not be read. The second used to be
 * silent — sliders on defaults, Save disabled, nothing said. A read still IN FLIGHT is
 * deliberately not a panel: nothing has gone wrong and it clears itself.
 */
export function ownBallotRead(read: {
  /** The query errored — including on a refetch, with an earlier response retained. */
  readonly failed: boolean
  /** Has a response landed at all? False only while the first read is in flight. */
  readonly arrived: boolean
  /** The ballots that response yielded, `undefined` when none could be read. */
  readonly ballots?: Record<string, PrioritizationScore>
}): OwnBallotRead {
  return {
    ballots: read.ballots ?? {},
    inHand: read.ballots !== undefined,
    needsPanel: read.failed || (read.arrived && read.ballots === undefined),
  }
}

/**
 * The caller's own ballots as a map, or `undefined` when the response carried none that
 * can be read.
 *
 * `undefined` rather than `{}`, because the save guard turns on exactly this difference:
 * an empty map means "the response arrived and this reviewer has no ballot yet", which
 * is the first-ballot case and must stay saveable, while `undefined` means the sliders
 * are showing `DEFAULT_SCORE` and a save would write over numbers nobody has seen.
 *
 * Here for the reason `normalizeAggregates` is: `select` runs on whatever the wire
 * actually sent, and the declared response type is a promise about it rather than a
 * proof. `null`, a string, or an array all reach this as `scores` and all used to pass
 * a `=== undefined` check on the field while leaving the page on defaults.
 *
 * A row that STORED NOTHING READABLE is dropped — not an object, no readable axis and no
 * note (see `storedSomething`, which is the floor the per-field `.catch()`es cannot
 * enforce). That lands the document in the state a first ballot already occupies:
 * `getScore` answers `DEFAULT_SCORE` for a key it does not hold, so the sliders show what
 * they would have shown anyway. Coercing such a row under its own key was the same thing
 * on screen — the save is offered either way, since the guard is about the MAP — but it
 * put a value nobody stored into the map that `applyBallotEdits` merges and that any
 * "documents I have scored" count would read as a ballot.
 *
 * `document_id` is taken from the MAP KEY, not from the row: the key is what every
 * lookup on this page uses, so a row disagreeing with its own key would produce a
 * ballot that cannot be found. Never throws, for the same reason as
 * `normalizeAggregates` — a throw in a `select` turns a readable response into a failed
 * query.
 */
export function normalizeScores(raw: unknown): Record<string, PrioritizationScore> | undefined {
  const asMap = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!asMap.success) return undefined
  return Object.fromEntries(
    Object.entries(asMap.data).flatMap(([documentId, value]): [string, PrioritizationScore][] => {
      const parsed = OwnBallotSchema.safeParse(value)
      return parsed.success && storedSomething(value)
        ? [[documentId, { ...parsed.data, document_id: documentId }]]
        : []
    }),
  )
}

/**
 * Did this row actually store anything, or would keeping it invent a ballot?
 *
 * The floor `OwnBallotSchema` cannot enforce: every field carries `.catch()`, so `{}` and
 * `{impact: 'high'}` PARSE — successfully — into a full `DEFAULT_SCORE`-shaped row. Without
 * this, "an unreadable row is dropped" was true only of a row that is not an object at all,
 * and the map still gained fabricated ballots. Same rule as `parseAggregate`'s axis floor,
 * asked of the RAW row because `.catch()` has by then erased the difference between "the
 * reviewer scored this 0" and "this field was unreadable".
 *
 * A NOTE counts on its own: `PATCH` assigns only the fields an entry carries, so a reviewer
 * who saved a justification without moving a slider has a note-only ballot stored, and
 * dropping it would lose their words.
 */
function storedSomething(raw: unknown): boolean {
  const row = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!row.success) return false
  return AXIS_FIELDS.some((axis) => READABLE_AXIS.safeParse(row.data[axis]).success)
    || z.string().min(1).safeParse(row.data.notes).success
}

/**
 * What the resting row shows: the team's composite, who voted, how far apart.
 *
 * `null` means NOBODY HAS SCORED THIS, which is a different statement from "the
 * team scored it low" and has to stay different in the row and in the sort —
 * hence a null rather than a zeroed record.
 */
export interface TeamScore {
  /**
   * The composite AS THE ROW PRINTS IT, rounded to the one decimal the page shows.
   *
   * The only composite on this type. The raw weighted sum is deliberately NOT carried
   * beside it, for the reason the raw axes are not: nothing outside `getTeamScore`
   * needs it, and a second unrounded copy of the value everything is supposed to read
   * one rounding of is how the band and the number beside it came to disagree in the
   * first place. `calculatePriorityScore` is exported for anyone who genuinely wants
   * the unrounded arithmetic.
   *
   * Every classification reads this rather than `composite`, because the raw
   * weighted sum is an IEEE-754 value: four means of 4 sum to 3.9999999999999996,
   * which the row prints as `4.0` while an unrounded `>= 4` test calls it Medium.
   * Rounding once, here, is what makes the printed number and the band that
   * describes it agree by construction rather than by two matching literals.
   */
  readonly displayComposite: number
  /**
   * The two sortable axes AS THE ROW PRINTS THEM, for the same reason
   * `displayComposite` exists — and for a reason that needs no floating-point dust.
   *
   * `_aggregate_scores` rounds each mean to TWO decimals (`round(…, 2)`) and the row
   * prints ONE (`.toFixed(1)`), so 4.25 and 4.34 are both ordinary backend output, both
   * print `4.3`, and ordering them by the raw value ranks two rows a reader sees as
   * identical — worse, it swaps them when the direction is toggled, which is the
   * instability `sortPRFAQs` negates rather than reverses to avoid. Rounding here, once,
   * makes the printed axis and the order it produces the same number.
   *
   * The RAW `impact` / `timeToMarket` are deliberately not carried alongside them. They
   * had no reader left once the row and both axis sorts moved here, and a second,
   * unrounded copy of a value whose whole point is that everything reads one rounding is
   * exactly the drift this replaced. The unrounded means are still on the
   * `PrioritizationAggregate` for anything that genuinely needs them.
   */
  readonly displayImpact: number
  readonly displayTimeToMarket: number
  readonly reviewerCount: number
  /**
   * The range of the composite across reviewers who scored every axis, or `null`
   * below two of them. The API reports 0.0 in that case, which would read as
   * agreement on a row where there is nothing to agree with.
   */
  readonly spread: number | null
}

/**
 * The one decimal the page prints a composite to.
 *
 * Module-private, and deliberately so: `displayComposite` exists to be the ONE
 * rounded value the row, the band and the stats cards all read, and an exported
 * rounding helper invites a second call site that rounds independently — which is
 * the drift `displayComposite` was introduced to end. Everything outside this file
 * reads the rounded value off `getTeamScore`.
 */
const roundToDisplay = (composite: number): number => Math.round(composite * 10) / 10

/**
 * The team's view of one document, or `null` when nobody has scored it.
 *
 * Absence from the map IS the unscored signal — the backend omits a document
 * with no votes rather than emitting a zero row — so this deliberately has no
 * `DEFAULT_SCORE`-style fallback. `Object.hasOwn` rather than a truthiness check
 * on the lookup, so an inherited property name (`'toString'`) cannot answer for a
 * document.
 */
export function getTeamScore(
  aggregates: Record<string, PrioritizationAggregate>,
  docId: string,
): TeamScore | null {
  if (!Object.hasOwn(aggregates, docId)) return null
  const aggregate = aggregates[docId]
  return {
    displayComposite: roundToDisplay(calculatePriorityScore(aggregate)),
    displayImpact: roundToDisplay(aggregate.impact),
    displayTimeToMarket: roundToDisplay(aggregate.time_to_market),
    reviewerCount: aggregate.reviewer_count,
    spread: aggregate.reviewer_count > 1 ? aggregate.score_spread : null,
  }
}

/**
 * What one row may say about the team — the four states, resolved in one place.
 *
 * A read state instead of a map means nothing is known about ANY document, so no row
 * may claim nobody voted on it. That check comes first, before the per-document
 * lookup, because it is a fact about the response rather than about the document: a
 * missing key in a map that has not arrived says nothing, whether it never will or
 * merely has not yet.
 */
export function getTeamView(aggregates: TeamAggregates, docId: string): TeamView {
  if (aggregates === 'unavailable') return { kind: 'unavailable' }
  if (aggregates === 'loading') return { kind: 'loading' }
  const team = getTeamScore(aggregates, docId)
  return team === null ? { kind: 'unscored' } : {
    kind: 'scored',
    team,
  }
}

/**
 * Did the reviewers actually disagree — the one rule two components both need.
 *
 * `null` team is "nobody voted", `spread === null` is "fewer than two comparable
 * ballots, so there was nothing to disagree with", and `0` is "the comparable
 * ballots agreed". None of the three is a disagreement worth pointing a reader at,
 * and all three used to be re-derived separately in the badge and in the panel —
 * two spellings of one rule, which is where drift starts. One function, so the two
 * places that ask cannot answer differently.
 *
 * A type PREDICATE rather than a plain boolean, so a caller that has asked the
 * question can then read `team.spread` as the number it is. Both call sites render
 * the spread right after the guard, and without the narrowing each would need a
 * `?? 0` fallback for a case the guard has already excluded — which is what made
 * the rule re-derivable in the first place.
 */
export const reviewersDisagreed = (
  team: TeamScore | null,
): team is TeamScore & { readonly spread: number } => (
  team !== null && team.spread !== null && team.spread > 0
)

/**
 * The longest note a ballot may carry.
 *
 * Duplicated from `MAX_BALLOT_NOTE_LEN` in the backend's `projects_handler.py`,
 * which REFUSES a longer note rather than truncating it — the characters past the
 * bound are content, not a number that can be clamped. So the page has to know the
 * number too: `fetchApi` throws `API Error: 400` and discards the response body, so
 * a refusal the page cannot anticipate arrives as a Save button that appears to do
 * nothing.
 *
 * The pair is pinned by
 * `lambda/api/test/test_prioritization_note_bound_lockstep.py`, because a comment
 * saying the two agree cannot fail CI.
 */
export const MAX_NOTE_LENGTH = 2000

/**
 * The documents among the caller's pending edits whose note the API will refuse.
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
export function overLongNoteDocuments(
  edits: Record<string, { readonly notes?: string | null }>,
): string[] {
  return Object.entries(edits)
    .filter(([, score]) => noteLength(score.notes) > MAX_NOTE_LENGTH)
    .map(([documentId]) => documentId)
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
  return [...(notes ?? '')].length
}

export const getScoreColor = (score: number, max: number = 5): string => {
  const ratio = score / max
  if (ratio >= 0.8) return 'text-green-600 bg-green-50'
  if (ratio >= 0.6) return 'text-blue-600 bg-blue-50'
  if (ratio >= 0.4) return 'text-yellow-600 bg-yellow-50'
  return 'text-red-600 bg-red-50'
}

/**
 * Which band a document falls in.
 *
 * `'none'` ONLY when the team view arrived and nobody had scored the document;
 * `'unavailable'` and `'loading'` when it did not arrive, which is not a fact about
 * the document and must not be counted or labelled as one.
 */
export type PriorityBand = 'high' | 'medium' | 'low' | 'none' | 'unavailable' | 'loading'

/**
 * The band the row is labelled with and the stats cards count by.
 *
 * Takes the team VIEW rather than a number, so neither of the two non-scored
 * states has to be encoded as a low value. It used to be
 * `getPriorityLabel(team?.composite ?? 0, t)`, which collapsed "nobody scored
 * this" into 0: a proposal three reviewers unanimously rated 1 across every axis
 * showed `1.0`, `Reviewers 3` and the band "Not Scored" — the same label as a
 * document nobody had opened. So `'none'` is reachable only from `'unscored'` and
 * every scored composite bands at least `'low'`. `'unavailable'` and `'loading'` are
 * separate again, because a read that failed — or has not finished — says nothing
 * about how anyone scored anything.
 *
 * Classifies `displayComposite`, the value the row PRINTS, so the label and the
 * number beside it cannot disagree. Against `composite` the thresholds are unsafe:
 * team means of 4 on all four axes sum to 3.9999999999999996, printed `4.0` and
 * banded Medium.
 */
export const priorityBand = (view: TeamView): PriorityBand => {
  if (view.kind === 'unavailable') return 'unavailable'
  if (view.kind === 'loading') return 'loading'
  if (view.kind === 'unscored') return 'none'
  if (view.team.displayComposite >= 4) return 'high'
  if (view.team.displayComposite >= 3) return 'medium'
  return 'low'
}

/**
 * How each band is named and tinted. One table, so the row and the cards agree.
 *
 * `i18nKey` is namespace-QUALIFIED, for the reason documented on
 * `SCORABLE_TYPE_META`: `scripts/i18n-check.mjs` only collects a data-held key when
 * it carries a namespace, so a bare `'priority.high'` is invisible to it and these
 * four become deletion candidates in a cleanup pass — leaving every row labelled
 * with a raw key path. The prefix is in the TYPE as well as the values, so dropping
 * it fails to compile rather than only failing a test.
 */
const BAND_STYLE: Record<PriorityBand, {
  readonly i18nKey: `prioritization:${string}`;
  readonly color: string
}> = {
  high: {
    i18nKey: 'prioritization:priority.high',
    color: 'bg-green-100 text-green-800',
  },
  medium: {
    i18nKey: 'prioritization:priority.medium',
    color: 'bg-blue-100 text-blue-800',
  },
  low: {
    i18nKey: 'prioritization:priority.low',
    color: 'bg-yellow-100 text-yellow-800',
  },
  none: {
    i18nKey: 'prioritization:priority.none',
    color: 'bg-gray-100 text-gray-600',
  },
  // Names the READ, not the document. Reusing `priority.none` ("Not Scored") here
  // would assert that nobody has voted on a document whose votes simply could not
  // be fetched — the ambiguity the error panel above the list exists to close.
  unavailable: {
    i18nKey: 'prioritization:team.unavailable',
    color: 'bg-gray-100 text-gray-600',
  },
  // Says the answer is coming, which is neither "nobody voted" nor "we could not
  // find out": a reader who sees "Not Scored" during the read has no way to know it
  // will change, and the error panel is not on screen to retract it because nothing
  // has gone wrong.
  // `text-gray-600`, not the fainter `text-gray-400` this started as: a label whose whole
  // job is to stop a reader misreading a row must be readable to make it. Faintness is
  // not what tells these three apart anyway — the label text is, since the others are
  // grey too.
  //
  // Measured from the PINNED Tailwind v4 palette (its oklch values converted to sRGB), on
  // this `bg-gray-100` #f3f4f6, at `text-xs` where AA wants 4.5:1:
  //   gray-400 #99a1af → 2.36:1 FAIL · gray-500 #6a7282 → 4.39:1 FAIL ·
  //   gray-600 #4a5565 → 6.87:1 PASS
  // gray-500 is why `unavailable` moved as well: it looks like a pass and is not. (An
  // earlier note here claimed 4.8:1 for it — that was the v3 hex, and wrong.)
  loading: {
    i18nKey: 'prioritization:team.loading',
    color: 'bg-gray-100 text-gray-600',
  },
}

export const getPriorityLabel = (view: TeamView, t: (key: string) => string): {
  label: string;
  color: string
} => {
  const style = BAND_STYLE[priorityBand(view)]
  return {
    label: t(style.i18nKey),
    color: style.color,
  }
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
export function getScore(scores: Record<string, PrioritizationScore>, docId: string): PrioritizationScore {
  const stored = Object.hasOwn(scores, docId) ? scores[docId] : undefined
  return stored ?? {
    ...DEFAULT_SCORE,
    document_id: docId,
  }
}

/**
 * One field of a pending edit, set without inventing the ones beside it.
 *
 * Field by field rather than through a computed key, because the four axes and the
 * note have different types and a computed assignment would have to widen them to
 * `number | string` — which is how a note could be stored as a number, or an axis as
 * a string, and only be discovered by the API refusing the save.
 */
export function withEditedField(
  edit: PrioritizationBallotEdit,
  field: keyof PrioritizationScore,
  value: number | string,
): PrioritizationBallotEdit {
  switch (field) {
    case 'notes': return {
      ...edit,
      notes: String(value),
    }
    case 'impact': return {
      ...edit,
      impact: Number(value),
    }
    case 'time_to_market': return {
      ...edit,
      time_to_market: Number(value),
    }
    case 'confidence': return {
      ...edit,
      confidence: Number(value),
    }
    case 'strategic_fit': return {
      ...edit,
      strategic_fit: Number(value),
    }
    // `document_id` identifies the ballot rather than describing it; a row cannot
    // edit which document it is.
    default: return edit
  }
}

/**
 * The ballots as the sliders should show them: what was saved, under what was edited.
 *
 * A pending edit carries ONLY the fields the reader set (see
 * `PrioritizationBallotEdit`), so the merge has to be per field rather than a spread
 * of one object over the other: `{...saved, ...edit}` would let an absent axis on the
 * edit overwrite a saved one with `undefined`, and the slider would render blank for a
 * score the reviewer had stored.
 *
 * Displayed scores stay derived rather than snapshotted, so a refetch after saving —
 * or landing here with a stale cache — shows the server's latest values (issue #95).
 */
export function applyBallotEdits(
  saved: Record<string, PrioritizationScore>,
  edits: Record<string, PrioritizationBallotEdit>,
): Record<string, PrioritizationScore> {
  const edited = Object.entries(edits).map(([docId, edit]): [string, PrioritizationScore] => {
    const base = getScore(saved, docId)
    return [docId, {
      document_id: docId,
      impact: edit.impact ?? base.impact,
      time_to_market: edit.time_to_market ?? base.time_to_market,
      confidence: edit.confidence ?? base.confidence,
      strategic_fit: edit.strategic_fit ?? base.strategic_fit,
      notes: edit.notes ?? base.notes,
    }]
  })
  return {
    ...saved,
    ...Object.fromEntries(edited),
  }
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
  readonly badgeColor: string
  readonly i18nKey: `prioritization:${string}`
}>> = {
  prd: { badgeColor: 'bg-blue-100 text-blue-700', i18nKey: 'prioritization:docType.prd' },
  prfaq: { badgeColor: 'bg-purple-100 text-purple-700', i18nKey: 'prioritization:docType.prfaq' },
}

export function isScorable(doc: ProjectDocument): boolean {
  // `in` operator checks key presence in SCORABLE_TYPE_META at runtime;
  // the type of `doc.document_type` is already constrained by the API union,
  // so no type assertion is needed and any typo in SCORABLE_TYPE_META is a
  // compile error at the Partial<Record<...>> definition above.
  return doc.document_type in SCORABLE_TYPE_META
}

export function collectPRFAQs(allProjectDetails: Array<{ documents?: ProjectDocument[] }> | undefined, projects: Project[] | undefined): PRFAQWithProject[] {
  if (!allProjectDetails || !projects) return []

  const result: PRFAQWithProject[] = []
  for (const [index, detail] of allProjectDetails.entries()) {
    if (!detail.documents) continue
    const project = projects[index]
    const scorableDocs = detail.documents.filter(isScorable)
    // Pick the most-recent prototype for this project — that's the one the
    // user just generated from the latest PRD/PR-FAQ.
    const prototypes = detail.documents
      .filter((doc: ProjectDocument) => doc.document_type === 'prototype')
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    const latestPrototype = prototypes[0]
    for (const doc of scorableDocs) {
      result.push({
        ...doc,
        project_id: project.project_id,
        project_name: project.name,
        prototype: latestPrototype,
      })
    }
  }
  return result
}

/** Which number on the team view each score sort field orders by. */
const TEAM_SORT_VALUE: Record<'priority_score' | 'impact' | 'time_to_market', (team: TeamScore) => number> = {
  // `displayComposite`, the value the row PRINTS, not the raw weighted sum — the rule
  // `displayComposite` was introduced for ("every classification reads this") applies
  // to the order as much as to the band. Rounding is monotonic, so raw never
  // contradicts printed; what it does is order two rows the reader sees as equal by a
  // difference nobody can see, and 3.9999999999999996 vs 4.0 is exactly that
  // difference. Reading the printed value makes them tie, and a tie keeps arrival
  // order in both directions (see `sortPRFAQs`).
  priority_score: (team) => team.displayComposite,
  // The axes are rounded here too, and NOT because of float dust: the backend rounds
  // each mean to two decimals and the row prints one, so 4.25 and 4.34 both print `4.3`
  // while the raw values still order — and flip when the reader toggles the direction.
  // Reading the printed value ties them instead. These two tie most often of the three,
  // because a 0–5 mean is a coarse scale.
  impact: (team) => team.displayImpact,
  time_to_market: (team) => team.displayTimeToMarket,
}

/**
 * Order two rows by the team's numbers — the same ones the rows display.
 *
 * Takes the RESOLVED team scores rather than the map and the ids, so the rule
 * "a row with no number cannot be ordered against one that has" is stated in the
 * signature: either side may be `null`, and a `null` on either side answers 0.
 * `sortPRFAQs` pins the unscored block itself, because whether a document has a
 * number at all is not a question the sort direction can answer (see there).
 *
 * Reads the TEAM aggregate, not the caller's own ballot, because that is what the row
 * shows: a list that displays one number and sorts by another is worse than either
 * alone. Before the team view, unscored rows sorted by whatever `DEFAULT_SCORE`
 * implied (a composite of 0.9, above anything scored genuinely low), so an untouched
 * proposal outranked one the team had looked at and rated poorly.
 *
 * The ONE comparator the page orders by, reached only through `sortPRFAQs`. It was
 * once shadowed by an exported `comparePRFAQs` wrapper that no production code
 * called, so a change here could break the shipped ordering with six test cases still
 * green against the wrapper. Tests reach the ordering where the page does.
 */
function compareByTeamScore(
  teamA: TeamScore | null,
  teamB: TeamScore | null,
  sortField: 'priority_score' | 'impact' | 'time_to_market',
): number {
  if (!teamA || !teamB) return 0
  const value = TEAM_SORT_VALUE[sortField]
  return value(teamA) - value(teamB)
}

/** Does this sort field read a number only a scored document has? */
const ORDERS_BY_TEAM_SCORE: Record<SortField, boolean> = {
  priority_score: true,
  impact: true,
  time_to_market: true,
  created_at: false,
  title: false,
}

/**
 * The rows in the order the page renders them.
 *
 * Direction is applied by NEGATING the comparator, not by reversing the sorted
 * array. `Array.prototype.reverse` on a stable sort's output also reverses TIES,
 * so two rows the sort considers equal swapped places purely because the reader
 * flipped the direction — and the team view ties often, since `impact` and
 * `time_to_market` order by a coarse 0–5 mean and every unscored row ties with
 * every other. Negating leaves equal rows in their original relative order in both
 * directions, which is what makes the list stable to look at.
 *
 * Unscored rows are pinned BELOW every scored row in BOTH directions, rather than
 * rising to the top when the reader asks for ascending order. "Nobody has voted on
 * this" is not a low score — that distinction is the whole point of reading the
 * aggregate — so it is not a value the direction toggle can meaningfully invert. A
 * reader flipping to ascending wants the worst-RATED proposals, and answering with
 * a block of never-voted-on ones puts unranked rows where the reader is looking for
 * ranked ones. They stay grouped at the bottom, where the row copy explains them.
 *
 * A read state instead of a map — the team read failed, or has not finished — leaves
 * the list in the order it arrived for the three score fields. There is no number to
 * rank by and no honest grouping either: pinning every row as "unscored" would order
 * the backlog by a property no row has been shown to have. Date and title still sort,
 * because those are document fields neither state touches.
 *
 * Each row's team score is resolved ONCE, before the sort, rather than per
 * comparison. `getTeamScore` allocates and recomputes a composite, and a comparator
 * calling it for both sides plus the grouping predicate did that `O(n log n)` times
 * for values constant across the whole sort.
 */
export function sortPRFAQs(
  prfaqs: readonly PRFAQWithProject[],
  aggregates: TeamAggregates,
  sortField: SortField,
  sortDirection: SortDirection,
): PRFAQWithProject[] {
  const direction = sortDirection === 'desc' ? -1 : 1
  const arrived = teamReadDelivered(aggregates) ? aggregates : null
  const ordersByTeamScore = ORDERS_BY_TEAM_SCORE[sortField] && arrived !== null
  const teams = new Map<string, TeamScore | null>(
    arrived === null ? [] : prfaqs.map(
      (prfaq) => [prfaq.document_id, getTeamScore(arrived, prfaq.document_id)],
    ),
  )
  const unscored = (prfaq: PRFAQWithProject) => (
    ordersByTeamScore && (teams.get(prfaq.document_id) ?? null) === null
  )
  return [...prfaqs].sort((a, b) => {
    const unscoredA = unscored(a)
    const unscoredB = unscored(b)
    // Ahead of the direction multiplier, so the block does not move when the
    // reader flips the direction.
    if (unscoredA !== unscoredB) return unscoredA ? 1 : -1
    if (unscoredA) return 0
    switch (sortField) {
      case 'created_at': return direction * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      case 'title': return direction * a.title.localeCompare(b.title)
      default: return direction * compareByTeamScore(
        teams.get(a.document_id) ?? null,
        teams.get(b.document_id) ?? null,
        sortField,
      )
    }
  })
}
