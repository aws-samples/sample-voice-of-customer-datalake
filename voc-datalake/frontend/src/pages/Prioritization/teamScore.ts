/**
 * @fileoverview What one row may say about the team: its score, its view state, its band and label.
 * @module pages/Prioritization/teamScore
 */

import { calculatePriorityScore } from './prioritizationUtils'
import type { CompositeAxes } from './prioritizationUtils'
import { UNREADABLE_ROW } from './teamRead'
import type { TeamAggregateRow, TeamAggregates } from './teamRead'

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
   *
   * Composited over the axes the team EXPRESSED, with the weights renormalised
   * to them (`getTeamScore`), and `null` when it expressed none — a notes-only
   * ballot produces an aggregate row with a reviewer count and no scores.
   * Weighing an unscored axis as 0 is what ranked a ballot of impact 4 alone at
   * 1.6, Low Priority — three zeros nobody entered outvoting the one number
   * somebody did (#343).
   */
  readonly displayComposite: number | null
  /**
   * The two sortable axes AS THE ROW PRINTS THEM, for the same reason
   * `displayComposite` exists — and for a reason that needs no floating-point dust.
   *
   * `_aggregate_scores` rounds each mean to TWO decimals (`round(…, 2)`) and the row
   * prints ONE (`.toFixed(1)`), so 4.25 and 4.34 are both ordinary backend output, both
   * print `4.3`, and ordering them by the raw value ranks two rows a reader sees as
   * identical — worse, it swaps them when the direction is toggled, which is the
   * instability `sortRows` negates rather than reverses to avoid. Rounding here, once,
   * makes the printed axis and the order it produces the same number.
   *
   * The RAW `impact` / `timeToMarket` are deliberately not carried alongside them. They
   * had no reader left once the row and both axis sorts moved here, and a second,
   * unrounded copy of a value whose whole point is that everything reads one rounding is
   * exactly the drift this replaced. The unrounded means are still on the
   * `PrioritizationAggregate` for anything that genuinely needs them.
   *
   * `null` means NO REVIEWER SCORED THIS AXIS. The backend reports 0.0 for an
   * axis nobody carried — its own docstring says 0.0 there means ABSENT — and
   * painting that as a number is what put "0.0 TTM" on a row whose one ballot
   * never mentioned time to market (#343). The row prints a dash for it and the
   * sort treats it as unorderable rather than as lowest. A GENUINE zero mean
   * cannot occur: the sliders put in 1–5, and the API's contract reads a stored
   * 0 as absent.
   */
  readonly displayImpact: number | null
  readonly displayTimeToMarket: number | null
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
/**
 * The weight each axis carries in the composite, read OFF the pinned formula.
 *
 * Derived once, at module load, by evaluating `calculatePriorityScore` on an
 * indicator per axis (this axis 1, the rest 0) rather than declared as a
 * second table of literals — so the renormalisation below cannot drift from
 * the formula the backend lockstep test pins
 * (`test_prioritization_weights_lockstep.py` parses that function's source).
 * One set of weights, two readers, zero copies.
 */
const COMPOSITE_AXES: readonly (keyof CompositeAxes)[] = ['impact', 'time_to_market', 'strategic_fit', 'confidence']
// Evaluated AT MODULE LOAD, and the file order is load-bearing:
// `calculatePriorityScore` is a `const` arrow, so this block must stay BELOW
// its declaration. Moving either past the other turns every import of this
// module into a TDZ ReferenceError — a blank page, not a test failure.
const weightOf = (axis: keyof CompositeAxes): number => calculatePriorityScore({
  impact: 0, time_to_market: 0, strategic_fit: 0, confidence: 0, [axis]: 1,
})
const COMPOSITE_WEIGHT: Readonly<Record<keyof CompositeAxes, number>> = {
  impact: weightOf('impact'),
  time_to_market: weightOf('time_to_market'),
  strategic_fit: weightOf('strategic_fit'),
  confidence: weightOf('confidence'),
}

/**
 * A team mean as the row may print it: the number, or `null` for an axis the
 * backend reported as 0.0 — its own contract for "no reviewer scored this".
 */
const expressedMean = (mean: number): number | null => (mean === 0 ? null : mean)

/**
 * The composite over the axes the team actually expressed, weights renormalised.
 *
 * Weighing an unexpressed axis as 0 is the arithmetic behind #343's ranking:
 * one ballot of impact 4 composited to 1.6 and banded Low Priority, three
 * zeros nobody entered outvoting the number somebody did. Renormalising says
 * the composite of what the team HAS said — impact 4 alone reads 4.0 — beside
 * a reviewer count that keeps "one person said one thing" visible. `null` when
 * nothing was expressed at all (a notes-only ballot), because there is no
 * number to print and inventing one is the defect this replaces.
 *
 * The backend's spread stays comparable without renormalising: it composites
 * only FULLY-scored ballots, where the expressed weights sum to 1 and this
 * computation is the identity (`_composite` in projects_handler.py records
 * the same argument from its side).
 */
const expressedComposite = (aggregate: CompositeAxes): number | null => {
  const expressedWeight = COMPOSITE_AXES.reduce(
    (sum, axis) => sum + (expressedMean(aggregate[axis]) === null ? 0 : COMPOSITE_WEIGHT[axis]),
    0,
  )
  if (expressedWeight === 0) return null
  return calculatePriorityScore(aggregate) / expressedWeight
}

export function getTeamScore(
  aggregates: Record<string, TeamAggregateRow>,
  rowId: string,
): TeamScore | null {
  const aggregate = Object.hasOwn(aggregates, rowId) ? aggregates[rowId] : undefined
  if (aggregate === undefined) return null
  // A row the response named but nothing in it could be read has no number, so it has no
  // `TeamScore`. `null` here would read as "nobody voted", which is why `getTeamView` asks
  // about `UNREADABLE_ROW` before it asks this — the two absences are not the same claim.
  if (aggregate === UNREADABLE_ROW) return null
  const composite = expressedComposite(aggregate)
  const impact = expressedMean(aggregate.impact)
  const timeToMarket = expressedMean(aggregate.time_to_market)
  return {
    displayComposite: composite === null ? null : roundToDisplay(composite),
    displayImpact: impact === null ? null : roundToDisplay(impact),
    displayTimeToMarket: timeToMarket === null ? null : roundToDisplay(timeToMarket),
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
export function getTeamView(aggregates: TeamAggregates, rowId: string): TeamView {
  if (aggregates === 'unavailable') return { kind: 'unavailable' }
  if (aggregates === 'loading') return { kind: 'loading' }
  // Per-DOCUMENT unavailability, asked before the score lookup for the same reason the
  // whole-response check is: the server named this document and we could not read what it
  // said about it, which is "we could not find out" rather than "nobody voted".
  if (aggregates[rowId] === UNREADABLE_ROW) return { kind: 'unavailable' }
  const team = getTeamScore(aggregates, rowId)
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

export const getScoreColor = (score: number, max: number = 5): string => {
  const ratio = score / max
  if (ratio >= 0.8) return 'text-ok bg-ok-subtle'
  if (ratio >= 0.6) return 'text-info bg-info-subtle'
  if (ratio >= 0.4) return 'text-warn bg-warn-subtle'
  return 'text-danger bg-danger-subtle'
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
  // A scored view with no composite: somebody said something (the reviewer
  // count is real) but nobody scored an axis — a notes-only ballot. There is
  // no number to band, and 'low' would rank a comment as a verdict; 'none' is
  // the honest label, and the row still shows the reviewer count beside it.
  if (view.team.displayComposite === null) return 'none'
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
    color: 'bg-ok-subtle text-ok',
  },
  medium: {
    i18nKey: 'prioritization:priority.medium',
    color: 'bg-info-subtle text-info',
  },
  low: {
    i18nKey: 'prioritization:priority.low',
    color: 'bg-warn-subtle text-warn',
  },
  none: {
    i18nKey: 'prioritization:priority.none',
    color: 'bg-bg-hover text-text',
  },
  // Names the READ, not the document. Reusing `priority.none` ("Not Scored") here
  // would assert that nobody has voted on a document whose votes simply could not
  // be fetched — the ambiguity the error panel above the list exists to close.
  unavailable: {
    i18nKey: 'prioritization:team.unavailable',
    color: 'bg-bg-hover text-text',
  },
  // Says the answer is coming, which is neither "nobody voted" nor "we could not
  // find out": a reader who sees "Not Scored" during the read has no way to know it
  // will change, and the error panel is not on screen to retract it because nothing
  // has gone wrong.
  // `text-text`, not the fainter `text-muted`: a label whose whole job is to stop a
  // reader misreading a row must be readable to make it. Faintness is not what tells
  // these three apart anyway — the label text is, since the others are neutral too.
  // (Under the old palette the faint grey measured 2.36:1 on its tint at `text-xs`,
  // under AA's 4.5:1; `text` on `bg-hover` is the theme's body-text pair in both
  // the Kiro dark and light themes, so the colour values live in `index.css`.)
  loading: {
    i18nKey: 'prioritization:team.loading',
    color: 'bg-bg-hover text-text',
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
