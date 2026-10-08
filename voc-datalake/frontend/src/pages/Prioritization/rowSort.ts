/**
 * @fileoverview The order the rows are listed in: by the team aggregate, never the caller own ballot.
 * @module pages/Prioritization/rowSort
 */

import type { PrioritizationRowView, SortDirection, SortField } from './prioritizationUtils'
import { teamReadDelivered } from './teamRead'
import type { TeamAggregates } from './teamRead'
import { getTeamView, teamScoreOf } from './teamScore'
import type { TeamScore, TeamView } from './teamScore'

/** Which number on the team view each score sort field orders by. */
const TEAM_SORT_VALUE: Record<'priority_score' | 'impact' | 'time_to_market', (team: TeamScore) => number | null> = {
  // `displayComposite`, the value the row PRINTS, not the raw weighted sum — the rule
  // `displayComposite` was introduced for ("every classification reads this") applies
  // to the order as much as to the band. Rounding is monotonic, so raw never
  // contradicts printed; what it does is order two rows the reader sees as equal by a
  // difference nobody can see, and 3.9999999999999996 vs 4.0 is exactly that
  // difference. Reading the printed value makes them tie, and a tie keeps arrival
  // order in both directions (see `sortRows`).
  priority_score: (team) => team.displayComposite,
  // The axes are rounded here too, and NOT because of float dust: the backend rounds
  // each mean to two decimals and the row prints one, so 4.25 and 4.34 both print `4.3`
  // while the raw values still order — and flip when the reader toggles the direction.
  // Reading the printed value ties them instead. These two tie most often of the three,
  // because a 0–5 mean is a coarse scale.
  //
  // `null` — an axis no reviewer scored, printed as a dash — reaches the
  // comparator and ties there: a dash is not a lowest value, and ordering by a
  // number the row does not show is the mismatch this table exists to prevent.
  impact: (team) => team.displayImpact,
  time_to_market: (team) => team.displayTimeToMarket,
}

/**
 * Order two rows by the team's numbers — the same ones the rows display.
 *
 * Takes the RESOLVED team scores rather than the map and the ids, so the rule
 * "a row with no number cannot be ordered against one that has" is stated in the
 * signature: either side may be `null`, and a `null` on either side answers 0.
 * `sortRows` pins the unscored block itself, because whether a document has a
 * number at all is not a question the sort direction can answer (see there).
 *
 * Reads the TEAM aggregate, not the caller's own ballot, because that is what the row
 * shows: a list that displays one number and sorts by another is worse than either
 * alone. Before the team view, unscored rows sorted by whatever `DEFAULT_SCORE`
 * implied (a composite of 0.9, above anything scored genuinely low), so an untouched
 * proposal outranked one the team had looked at and rated poorly.
 *
 * The ONE comparator the page orders by, reached only through `sortRows`. It was
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
  const a = value(teamA)
  const b = value(teamB)
  // An axis nobody scored prints as a dash, and a dash cannot be ordered
  // against a number — treating null as 0 would rank "nobody mentioned time to
  // market" below "the team rated it worst". Within `sortRows` this branch is
  // unreachable: `blockOf` groups a dash-in-this-column row with the
  // number-less block before any comparison, precisely because a null that
  // ties both a 5 and a 1 makes the order engine-dependent. Kept for the
  // direct caller, where a tie is the honest answer for one comparison.
  if (a === null || b === null) return 0
  return a - b
}

/** Does this sort field read a number only a scored ROW has? */
const ORDERS_BY_TEAM_SCORE: Record<SortField, boolean> = {
  priority_score: true,
  impact: true,
  time_to_market: true,
  created_at: false,
  title: false,
}

/**
 * Where each team-view state sorts, in render order: ranked rows, then rows the
 * response named but could not be read, then rows nobody has voted on.
 *
 * A `Record` over the kinds rather than conditionals in the comparator, for the
 * reason `READ_STATE_I18N_KEY` is one: a fifth state must be PLACED here to compile,
 * not silently fall into somebody's else branch. `unavailable` is reached here only
 * as the per-row marker — `sortRows` consults blocks once a map arrived, so the
 * container-level reading of that kind never gets this far. `loading` cannot reach it
 * at all for the same reason; its entry is the total function's answer, and `0` is
 * "no grouping", which is what the sort does for a whole loading backlog anyway.
 */
const SORT_BLOCK: Record<TeamView['kind'], number> = {
  scored: 0,
  loading: 0,
  unavailable: 1,
  unscored: 2,
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
 * A row the response named but could not be read is its OWN block, between the two:
 * folding it into the unscored block restated in the ordering exactly the conflation
 * the row label refuses — "we could not find out" filed under "nobody voted". It sits
 * ABOVE the unscored block because it is the weaker claim: the server said something
 * about this document and it may be scored anywhere in the ranked list, whereas
 * "nobody voted" is a settled absence; burying a possibly-ranked row beneath the
 * definitely-unranked ones would be the sort asserting the one thing it does not
 * know. Within the block, arrival order — there is no number to rank by.
 *
 * A read state instead of a map — the team read failed, or has not finished — leaves
 * the list in the order it arrived for the three score fields. There is no number to
 * rank by and no honest grouping either: pinning every row as "unscored" would order
 * the backlog by a property no row has been shown to have. Date and title still sort,
 * because those are document fields neither state touches.
 *
 * Each row's team VIEW is resolved ONCE, before the sort, rather than per
 * comparison. `getTeamView` allocates and recomputes a composite, and a comparator
 * calling it for both sides plus the grouping predicate did that `O(n log n)` times
 * for values constant across the whole sort.
 */
export function sortRows(
  rows: readonly PrioritizationRowView[],
  aggregates: TeamAggregates,
  sortField: SortField,
  sortDirection: SortDirection,
): PrioritizationRowView[] {
  const direction = sortDirection === 'desc' ? -1 : 1
  const arrived = teamReadDelivered(aggregates) ? aggregates : null
  const ordersByTeamScore = ORDERS_BY_TEAM_SCORE[sortField] && arrived !== null
  // Resolved ONCE per row, and the block and the score are both read off the one
  // resolved view, so the grouping and the ordering cannot disagree about what a row
  // is — `getTeamView` is where "a marked row is not an unscored one" already lives.
  const views = new Map<string, TeamView>(
    arrived === null ? [] : rows.map(
      (row) => [row.row_id, getTeamView(arrived, row.row_id)],
    ),
  )
  const teamOf = (row: PrioritizationRowView): TeamScore | null => {
    const view = views.get(row.row_id)
    return view === undefined ? null : teamScoreOf(view)
  }
  const blockOf = (row: PrioritizationRowView): number => {
    if (!ordersByTeamScore) return 0
    const view = views.get(row.row_id)
    if (view === undefined) return 0
    // A scored row with NO NUMBER IN THIS COLUMN — an axis nobody scored, or a
    // notes-only composite — prints a dash there, and a dash sorts with the
    // number-less rows rather than tying arbitrarily among the ranked ones: a
    // null that ties both a 5 and a 1 (which do not tie each other) makes the
    // final order depend on the engine's sort, not on the data. Grouped with
    // the unscored block because that is what the reader sees — no value in
    // the sorted column — while the row's own label still says which state it
    // is. Deciding this here, per row, is also what keeps the comparator's
    // null branch unreachable within the ranked block.
    if (view.kind === 'scored'
      && (sortField === 'priority_score' || sortField === 'impact' || sortField === 'time_to_market')
      && TEAM_SORT_VALUE[sortField](view.team) === null) {
      return SORT_BLOCK.unscored
    }
    return SORT_BLOCK[view.kind]
  }
  // REORDERS, never narrows — and something now depends on that beyond the list. The
  // heading's count is taken from this function's output while the "Total Proposals"
  // card counts its input, so the two agree only while every row given comes back. A
  // filter belongs in a separate step the count can be pointed at deliberately, not in
  // this comparator.
  return [...rows].sort((a, b) => {
    const blockA = blockOf(a)
    const blockB = blockOf(b)
    // Ahead of the direction multiplier, so the blocks do not move when the
    // reader flips the direction.
    if (blockA !== blockB) return blockA - blockB
    // Within the two number-less blocks there is nothing to rank by: arrival order.
    if (blockA !== 0) return 0
    switch (sortField) {
      case 'created_at': return direction * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      case 'title': return direction * a.title.localeCompare(b.title)
      default: return direction * compareByTeamScore(teamOf(a), teamOf(b), sortField)
    }
  })
}
