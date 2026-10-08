/**
 * @fileoverview The caller's OWN half of the scores read, and the stored rows it is keyed by.
 * @module pages/Prioritization/ownRead
 */

import { z } from 'zod'
import type {
  PrioritizationScore,
} from '../../api/types'
import type {
  PrioritizationRow,
} from '../../api/projectTypes'
import { DEFAULT_SCORE } from './prioritizationUtils'
import { AXIS_FIELDS, READABLE_AXIS, optionalFieldAsMap } from './teamRead'

/**
 * One axis of the CALLER'S OWN ballot: out of range clamps, unreadable degrades.
 *
 * Both catch to the axis's `DEFAULT_SCORE` value — 0, the shared unscored
 * sentinel — so a slider that cannot be given the reviewer's stored value reads
 * as UNSCORED rather than as a deliberate score. That used to differ per axis
 * (`time_to_market` degraded to 3, its siblings to 0), which meant an
 * unreadable TTM presented as a real mid-range vote; one sentinel ends the
 * asymmetry (#343). `TEAM_AXIS` also catches to 0 and the row renders a 0 team
 * mean as unscored, for the same reason: the backend reports 0.0 for an axis
 * nobody scored, and a number nobody entered must not read as one they did.
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
  // rewrite a reviewer's justification. `overLongNoteRows` is what refuses to SEND
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
 * `row_id` is taken from the MAP KEY, not from the entry: the key is what every
 * lookup on this page uses, so an entry disagreeing with its own key would produce a
 * ballot that cannot be found. Never throws, for the same reason as
 * `normalizeAggregates` — a throw in a `select` turns a readable response into a failed
 * query.
 */
export function normalizeScores(raw: unknown): Record<string, PrioritizationScore> | undefined {
  const asMap = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!asMap.success) return undefined
  return Object.fromEntries(
    Object.entries(asMap.data).flatMap(([rowId, value]): [string, PrioritizationScore][] => {
      const parsed = OwnBallotSchema.safeParse(value)
      return parsed.success && storedSomething(value)
        ? [[rowId, { ...parsed.data, row_id: rowId }]]
        : []
    }),
  )
}

/**
 * What each row IS, as the wire gave it: its project and its concrete document ids.
 *
 * Validated at the query boundary like both other halves of this response, and for
 * the same reason: a declared type is a promise about the wire rather than a proof
 * of it, and this map decides which documents a reviewer is shown inside a row.
 *
 * Absent answers an EMPTY MAP, not `undefined`: a deployment predating rows sends no
 * `rows` field, and the honest reading there is "this response describes no rows".
 * Unreadable answers `undefined`, because `{}` would be this parser asserting that the
 * backlog holds no rows at all — the same distinction `normalizeAggregates` draws one
 * field over, and it is the parser's to draw whether or not a given consumer acts on it.
 *
 * What the PAGE does with the two is deliberately the same, and stated at its call site:
 * neither adds a row to the list, and the rows it can still vouch for are the ones the
 * create route handed back. The difference is kept here because it is a fact about the
 * response, and because the page is not the only possible reader of this function — the
 * next one may well want to tell "no rows yet" apart from "we could not read them", and
 * collapsing it here would leave nothing to tell it from.
 *
 * A row that cannot be READ is dropped rather than kept under a marker. Unlike an
 * aggregate — where the difference between "nobody voted" and "we could not find
 * out" is a claim about a document — a row nothing can read has no documents to
 * show, no title to name it and nothing a reviewer could score, so there is no row
 * to render. A ballot keyed to it is then ignored on read, exactly as the backend
 * ignores one naming a row that no longer resolves.
 *
 * `row_id` is taken from the MAP KEY for the reason `normalizeScores` records: the
 * key is what every lookup addresses.
 */
export function normalizeRows(raw: unknown): Record<string, PrioritizationRow> | undefined {
  const entries = optionalFieldAsMap(raw)
  if (entries === undefined) return undefined
  return Object.fromEntries(
    Object.entries(entries).flatMap(([rowId, value]): [string, PrioritizationRow][] => {
      const row = normalizeRow(value, rowId)
      return row ? [[rowId, row]] : []
    }),
  )
}

/**
 * ONE row, validated the same way — for the response that carries a row on its own.
 *
 * `POST /projects/prioritization/rows` answers `{row: ...}` rather than a map, and that
 * answer is a row the page then RENDERS: the create route is idempotent and hands back
 * the stored record, which is what lets the list survive a prioritization read that
 * failed or has not landed. Reading `row.row_id` off an unvalidated body to decide that
 * is the same mistake `normalizeRows` exists to prevent one field over — a declared
 * response type is a promise about the wire, and `{success: true, row: {}}` satisfies
 * the compiler while throwing at the first property access.
 *
 * `rowId` is optional because the two callers know the id from different places: the
 * read has it as the MAP KEY (what every lookup addresses), while a lone row carries it
 * only in its own body. Either way an EMPTY id answers `undefined` — a row the page
 * cannot address is one no ballot, aggregate or expansion could ever be looked up
 * against, which is the same reason `collectRows` drops a row that resolves to no
 * document.
 */
export function normalizeRow(raw: unknown, rowId?: string): PrioritizationRow | undefined {
  const parsed = RowSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const id = rowId ?? parsed.data.row_id
  return id.length > 0 ? { ...parsed.data, row_id: id } : undefined
}

/**
 * The row record as this page accepts it.
 *
 * `project_id` and `document_ids` carry NO fallback, deliberately: they are what
 * makes a row renderable. A row whose project cannot be read belongs to no project
 * on screen, and one whose document ids cannot be read is a row with nothing to
 * score — an invented `''` or `[]` would put an empty, unscorable row in the list
 * under a project nobody can open. `document_ids` may legitimately be EMPTY on the
 * wire only if a future phase allows it; `collectRows` drops such a row for the same
 * reason, so the two agree.
 *
 * The rest degrades, because none of it decides whether the row exists: a missing
 * `prototype_id` means "no prototype", and `is_default`/`created_at`/`is_frozen` are
 * metadata the list does not depend on.
 *
 * `is_frozen` degrades to FALSE, and that direction is deliberate. It is the API's
 * answer to "has a ballot landed on this row", and the freeze itself is a DATABASE
 * CONDITION on the write — so this field only ever decides whether a control is
 * offered, never whether an edit is allowed. An unreadable value that defaulted to
 * `true` would hide a control on a row that is perfectly editable, with nothing on
 * screen explaining why; defaulting to `false` offers a control whose request the
 * server refuses with a 409 the page can state. A courtesy that occasionally shows
 * too much beats one that silently withholds.
 *
 * `z.object`, not `looseObject`: this is the shape the page ACCEPTS, matching
 * `OwnBallotSchema`'s reasoning — a boundary that keeps what it does not understand
 * is not saying what it accepts. Which is why a field the API publishes has to be
 * DECLARED here rather than left to be stripped: an undeclared `is_frozen` parses
 * fine and is silently discarded, so the page could never learn the row was frozen
 * and nothing would fail to say so. `test_prioritization_row_payload_lockstep.py`
 * pins every key `_row_payload` returns against this list for that reason.
 */
/**
 * How many documents one row may hold.
 *
 * `MAX_ROW_DOCUMENT_IDS` in the backend's `projects_handler.py`, which TRUNCATES a
 * composition at this length. Stated here so the two boundaries describe the same
 * contract rather than the client accepting a row the API could never have written —
 * a row longer than this is a response nothing on the server produced, which is
 * exactly what a boundary that "says what it accepts" should refuse.
 *
 * The pair is pinned by `lambda/api/test/test_prioritization_row_bound_lockstep.py`,
 * because a comment saying the two agree cannot fail CI.
 *
 * WHAT AN OVER-LONG ROW COSTS, and why that is acceptable HERE and not later. A row
 * failing this bound is dropped by `normalizeRows` along with its ballots, with nothing
 * on screen saying why. In phase 1 that state is unreachable from anything the product
 * does — the API truncates every composition it writes, so a longer row is a response no
 * server produced — which makes "drop it" the same answer as for any other unreadable
 * row. Phase 2 adds composition EDITING, and then a row over the bound becomes something
 * a person could have caused; at that point this belongs behind the `UNREADABLE_ROW`
 * marker path (which exists to say "we could not read this" instead of "this is not
 * there") rather than in the silent drop, and the API's answer to an over-long
 * composition should be a 400 naming the bound rather than a truncation.
 */
export const MAX_ROW_DOCUMENT_IDS = 25

const RowSchema = z.object({
  row_id: z.string().catch(''),
  project_id: z.string().min(1),
  document_ids: z.array(z.string().min(1)).max(MAX_ROW_DOCUMENT_IDS),
  prototype_id: z.string().catch(''),
  is_default: z.boolean().catch(false),
  created_at: z.string().catch(''),
  is_frozen: z.boolean().catch(false),
})

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
