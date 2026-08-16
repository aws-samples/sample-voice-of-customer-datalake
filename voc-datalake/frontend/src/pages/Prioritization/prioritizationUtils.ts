/**
 * @fileoverview Shared utilities for the prioritization feature.
 * @module pages/Prioritization/prioritizationUtils
 */

import { z } from 'zod'
import type {
  Project, ProjectDocument, PrioritizationScore, PrioritizationAggregate,
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
 * spread that is missing, out of range or not a number degrades to 0 rather than
 * taking the row off the page, because a partial aggregate is still worth showing.
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
 */
const TEAM_AXIS = z.number().min(0).max(5)

const TeamAggregateSchema = z.looseObject({
  impact: TEAM_AXIS.catch(0),
  time_to_market: TEAM_AXIS.catch(0),
  confidence: TEAM_AXIS.catch(0),
  strategic_fit: TEAM_AXIS.catch(0),
  reviewer_count: z.number().int().min(1),
  // In the same unit as `calculatePriorityScore`, so it is readable as "how far
  // apart two reviewers were, in slider notches". Bounded by that scale.
  score_spread: TEAM_AXIS.catch(0),
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
 * `.catch(0)` has by then erased the difference between "the team scored this 0"
 * and "this field was unreadable". A row with no readable axis at all asserts a
 * score nobody cast, so it is dropped — the same argument as `reviewer_count`,
 * and it lands the row in the same "nobody scored this" state the page already
 * renders honestly.
 */
function parseAggregate(value: unknown): PrioritizationAggregate | null {
  const parsed = TeamAggregateSchema.safeParse(value)
  if (!parsed.success) return null
  const raw = z.record(z.string(), z.unknown()).safeParse(value)
  if (!raw.success) return null
  const hasReadableAxis = AXIS_FIELDS.some((axis) => TEAM_AXIS.safeParse(raw.data[axis]).success)
  return hasReadableAxis ? parsed.data : null
}

/**
 * The team view per document, from whatever the wire actually sent.
 *
 * Never throws and never rejects the whole map over one bad row: this feeds a
 * `select`, so a throw here would turn a readable response into a failed query
 * and take the page's error panel with it. A row that cannot be read is dropped,
 * and a dropped row renders as unscored — the same state as a document nobody
 * has voted on, which is the honest reading when the team data is unusable.
 */
export function normalizeAggregates(raw: unknown): Record<string, PrioritizationAggregate> {
  const asMap = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!asMap.success) return {}
  return Object.fromEntries(
    Object.entries(asMap.data).flatMap(([documentId, value]): [string, PrioritizationAggregate][] => {
      const aggregate = parseAggregate(value)
      return aggregate ? [[documentId, aggregate]] : []
    }),
  )
}

/**
 * What the resting row shows: the team's composite, who voted, how far apart.
 *
 * `null` means NOBODY HAS SCORED THIS, which is a different statement from "the
 * team scored it low" and has to stay different in the row and in the sort —
 * hence a null rather than a zeroed record.
 */
export interface TeamScore {
  readonly composite: number
  /**
   * The composite AS THE ROW PRINTS IT, rounded to the one decimal the page shows.
   *
   * Every classification reads this rather than `composite`, because the raw
   * weighted sum is an IEEE-754 value: four means of 4 sum to 3.9999999999999996,
   * which the row prints as `4.0` while an unrounded `>= 4` test calls it Medium.
   * Rounding once, here, is what makes the printed number and the band that
   * describes it agree by construction rather than by two matching literals.
   */
  readonly displayComposite: number
  readonly impact: number
  readonly timeToMarket: number
  readonly reviewerCount: number
  /**
   * The range of the composite across reviewers who scored every axis, or `null`
   * below two of them. The API reports 0.0 in that case, which would read as
   * agreement on a row where there is nothing to agree with.
   */
  readonly spread: number | null
}

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
  const composite = calculatePriorityScore(aggregate)
  return {
    composite,
    displayComposite: roundToDisplay(composite),
    impact: aggregate.impact,
    timeToMarket: aggregate.time_to_market,
    reviewerCount: aggregate.reviewer_count,
    spread: aggregate.reviewer_count > 1 ? aggregate.score_spread : null,
  }
}

/** The one decimal the page prints a composite to. */
export const roundToDisplay = (composite: number): number => Math.round(composite * 10) / 10

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

/** Which band a document falls in — `'none'` ONLY when nobody has scored it. */
export type PriorityBand = 'high' | 'medium' | 'low' | 'none'

/**
 * The band the row is labelled with and the stats cards count by.
 *
 * Takes the team score rather than a number, so that "nobody has scored this"
 * arrives as `null` instead of being encoded as a low value. It used to be
 * `getPriorityLabel(team?.composite ?? 0, t)`, which collapsed the two: a proposal
 * three reviewers unanimously rated 1 across every axis showed `1.0`,
 * `Reviewers 3` and the band "Not Scored" — the same label as a document nobody
 * had opened. "Scored low" and "unscored" have to stay distinct in the row, not
 * only in the sort, so `'none'` is now reachable only from `null` and every scored
 * composite bands at least `'low'`.
 *
 * Classifies `displayComposite`, the value the row PRINTS, so the label and the
 * number beside it cannot disagree. Against `composite` the thresholds are unsafe:
 * team means of 4 on all four axes sum to 3.9999999999999996, printed `4.0` and
 * banded Medium.
 */
export const priorityBand = (team: TeamScore | null): PriorityBand => {
  if (team === null) return 'none'
  if (team.displayComposite >= 4) return 'high'
  if (team.displayComposite >= 3) return 'medium'
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
}

export const getPriorityLabel = (team: TeamScore | null, t: (key: string) => string): {
  label: string;
  color: string
} => {
  const style = BAND_STYLE[priorityBand(team)]
  return {
    label: t(style.i18nKey),
    color: style.color,
  }
}

export function getScore(scores: Record<string, PrioritizationScore>, docId: string): PrioritizationScore {
  return scores[docId] ?? {
    ...DEFAULT_SCORE,
    document_id: docId,
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
  priority_score: (team) => team.composite,
  impact: (team) => team.impact,
  time_to_market: (team) => team.timeToMarket,
}

/**
 * Order two SCORED rows by the team's numbers — the same ones the row displays.
 *
 * Only reached once both rows are known to be scored; `sortPRFAQs` pins the
 * unscored block itself, because whether a document has a number at all is not a
 * question the sort direction can answer (see there).
 */
function compareByTeamScore(
  teamA: TeamScore,
  teamB: TeamScore,
  sortField: 'priority_score' | 'impact' | 'time_to_market',
): number {
  const value = TEAM_SORT_VALUE[sortField]
  return value(teamA) - value(teamB)
}

/**
 * The list order, ascending, for two rows that both carry the sort's data.
 *
 * Reads the TEAM aggregate, not the caller's own ballot, because that is what the
 * row now shows: a list that displays one number and sorts by another is worse
 * than either alone. `created_at` and `title` are document fields and are
 * unaffected.
 *
 * Unscored rows compare EQUAL here — to each other and to anything else — because
 * ordering them is `sortPRFAQs`' job, not this function's. Before the team view
 * they sorted by whatever `DEFAULT_SCORE` implied (a composite of 0.9, above
 * anything scored genuinely low), so an untouched proposal outranked one the team
 * had looked at and rated poorly.
 */
export function comparePRFAQs(a: PRFAQWithProject, b: PRFAQWithProject, aggregates: Record<string, PrioritizationAggregate>, sortField: SortField): number {
  switch (sortField) {
    case 'created_at': return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    case 'title': return a.title.localeCompare(b.title)
    default: {
      const teamA = getTeamScore(aggregates, a.document_id)
      const teamB = getTeamScore(aggregates, b.document_id)
      // A row with no team score has no value on this axis, so it cannot be
      // ordered against one that has: `sortPRFAQs` groups those rows instead.
      if (!teamA || !teamB) return 0
      return compareByTeamScore(teamA, teamB, sortField)
    }
  }
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
 */
export function sortPRFAQs(
  prfaqs: readonly PRFAQWithProject[],
  aggregates: Record<string, PrioritizationAggregate>,
  sortField: SortField,
  sortDirection: SortDirection,
): PRFAQWithProject[] {
  const direction = sortDirection === 'desc' ? -1 : 1
  const unscored = ORDERS_BY_TEAM_SCORE[sortField]
    ? (prfaq: PRFAQWithProject) => getTeamScore(aggregates, prfaq.document_id) === null
    : () => false
  return [...prfaqs].sort((a, b) => {
    const unscoredA = unscored(a)
    const unscoredB = unscored(b)
    // Ahead of the direction multiplier, so the block does not move when the
    // reader flips the direction.
    if (unscoredA !== unscoredB) return unscoredA ? 1 : -1
    if (unscoredA) return 0
    return direction * comparePRFAQs(a, b, aggregates, sortField)
  })
}
