/**
 * @fileoverview Tests for rowSort — the order the rows are listed in.
 */
import { describe, it, expect } from 'vitest'
import { calculatePriorityScore } from './prioritizationUtils'
import type { PrioritizationRowView } from './prioritizationUtils'
import { sortRows } from './rowSort'
import { UNREADABLE_ROW } from './teamRead'
import type { TeamAggregateRow } from './teamRead'
import { getTeamScore } from './teamScore'
import type { PrioritizationAggregate } from '../../api/projectTypes'
import { aggregate, byLocale } from './prioritization-unit-fixtures'

/**
 * A row as the sort sees it: an id, a title, a date, and the documents it holds.
 *
 * `row_id` is what the aggregate is keyed by — the sort looks up `row.row_id`, so a
 * fixture keyed by a document id would exercise nothing the page does. The single
 * document exists because a row must resolve to at least one to be rendered at all;
 * multi-document rows are `collectRows`' subject, not the sort's.
 */
const rowView = (
  rowId: string, title: string, createdAt: string,
): PrioritizationRowView => ({
  row_id: rowId,
  project_id: 'p1',
  project_name: 'P1',
  title,
  created_at: createdAt,
  // Unfrozen and default, because the sort is indifferent to both: they decide which
  // COMPOSITION controls a row offers, not where it lands in the order.
  is_frozen: false,
  is_default: true,
  documents: [{
    document_id: `${rowId}-doc`,
    document_type: 'prfaq' as const,
    title,
    content: '',
    created_at: createdAt,
  }],
  // Derived by `collectRows` on the page and asserted there and in
  // `rowLineage.test.ts`; the sort is indifferent to it for the same reason it is
  // indifferent to the freeze — lineage decides what a row SAYS, never where it
  // lands. Stated as the single-document row's real answer (one document records
  // nothing, so `origin: 'none'`) rather than as a placeholder, so a fixture
  // nobody reads cannot claim a state the classifier would not produce.
  lineage: {
    state: 'absent' as const,
    reason: 'noneRecorded' as const,
    stale: false,
    fresherDocumentIds: [],
  },
})

const rowA = rowView('a', 'Alpha', '2025-01-01')
const rowB = rowView('b', 'Beta', '2025-01-02')

describe('the sort orders by the TEAM aggregate, not the caller own ballot', () => {
  // Asserted through `sortRows`, which is the ONLY way the page reaches the
  // ordering. These cases used to call an exported `comparePRFAQs` wrapper that no
  // production code called, so the comparator the page actually uses could have
  // regressed with every one of them still green.
  const idsOf = (rows: readonly { row_id: string }[]) => rows.map((row) => row.row_id)

  it('sorts by the team mean impact when the field is impact', () => {
    const aggregates: Record<string, PrioritizationAggregate> = {
      a: aggregate({ impact: 2, reviewer_count: 2 }),
      b: aggregate({ impact: 5, reviewer_count: 2 }),
    }

    expect(idsOf(sortRows([rowA, rowB], aggregates, 'impact', 'asc'))).toStrictEqual(['a', 'b'])
    expect(idsOf(sortRows([rowA, rowB], aggregates, 'impact', 'desc'))).toStrictEqual(['b', 'a'])
  })

  it('sorts by the team composite, not by the caller composite', () => {
    // The discriminating case: a's TEAM composite is the higher one, b's is lower,
    // and the documents are supplied in the order a no-op sort would leave them. A
    // sort still reading the caller's own map has no entry for either document, ties
    // them, and leaves them as given — which is not "b above a".
    const aggregates: Record<string, PrioritizationAggregate> = {
      a: aggregate({ impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, reviewer_count: 2 }),
      b: aggregate({ impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, reviewer_count: 2 }),
    }

    expect(idsOf(sortRows([rowB, rowA], aggregates, 'priority_score', 'desc'))).toStrictEqual(['a', 'b'])
  })

  it('ranks an unscored document BELOW one the team scored low, rather than above it', () => {
    // The defect this replaces: DEFAULT_SCORE composites to 0.9 (time_to_market 3
    // at weight 0.3), so an untouched proposal outranked one the team had looked
    // at and rated 1 across the board — composite 1.0. Absent from the aggregate
    // means nobody voted, which is not a low score.
    //
    // Asserted through `sortRows`, which owns the unscored block: the comparator
    // answers 0 for a row with no number on the axis (see below), and it is the sort
    // that then pins those rows to the bottom — in both directions, so this holds
    // ascending too rather than only in the default view.
    const aggregates: Record<string, PrioritizationAggregate> = {
      b: aggregate({ impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, reviewer_count: 1 }),
    }

    for (const direction of ['asc', 'desc'] as const) {
      const order = sortRows([rowA, rowB], aggregates, 'priority_score', direction)
      expect(order.map((row) => row.row_id), direction).toStrictEqual(['b', 'a'])
    }
  })

  it('groups a row with no number in the sorted column with the number-less, in both directions', () => {
    // Sorting by time to market: `a` never scored that axis (a partial ballot —
    // its TTM prints a dash), `b` scored it. A dash cannot be ordered against a
    // number, and letting the comparator tie it against every ranked row makes
    // the final order depend on the engine's sort rather than on the data —
    // null would tie both a 5 and a 1 that do not tie each other. So the dash
    // row is GROUPED below the ranked rows, deterministically, where the
    // number-less already live; its own label still says which state it is.
    const rowC = rowView('c', 'Gamma', '2025-01-03')
    const aggregates: Record<string, PrioritizationAggregate> = {
      a: aggregate({ impact: 5, reviewer_count: 2 }), // TTM unexpressed: dash
      b: aggregate({ impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, reviewer_count: 2 }),
      // c absent entirely: nobody voted.
    }

    for (const direction of ['asc', 'desc'] as const) {
      // The ranked row first, then the number-less block IN ARRIVAL ORDER (`a`
      // was supplied before `c`) in BOTH directions — the block neither ranks
      // its members against each other nor flips with the toggle, which is the
      // determinism this grouping exists for.
      expect(idsOf(sortRows([rowA, rowB, rowC], aggregates, 'time_to_market', direction)), direction)
        .toStrictEqual(['b', 'a', 'c'])
    }
  })

  it('returns every row it was given, whatever the field and direction', () => {
    // REORDERS, NEVER NARROWS — and something outside this file now depends on it: the
    // heading's count badge reads `sortedRows.length` while the "Total Proposals" card
    // reads the pre-sort `allRows.length`, so the two numbers on the page agree only
    // while this holds. A filter added to the comparator would make them disagree
    // silently, which is the failure this pins rather than describes.
    // `rowC` is local to the sibling cases, so this one mints its own third row.
    const rowC = rowView('c', 'Gamma', '2025-01-03')
    const rows = [rowA, rowB, rowC]
    // Scored on ONE axis only (`a`, `b`) and absent entirely (`c`), which is what makes
    // the four fields below land in three DIFFERENT grouping regimes rather than
    // repeating one: `impact` splits them (a and b have a number, c does not);
    // `time_to_market` and `priority_score` put all three in number-less blocks for two
    // different reasons (a scored row with no value on the axis, versus no aggregate at
    // all); and `created_at` is not team-ordered, so no grouping runs. The property has
    // to hold in all three, and a number-less block is where a row can quietly vanish.
    const aggregates: Record<string, PrioritizationAggregate> = {
      a: aggregate({ impact: 5, reviewer_count: 2 }),
      b: aggregate({ impact: 0, reviewer_count: 1 }),
    }

    for (const field of ['priority_score', 'impact', 'time_to_market', 'created_at'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        const sorted = sortRows(rows, aggregates, field, direction)
        expect(sorted, `${field}/${direction}`).toHaveLength(rows.length)
        // Length alone would accept a duplicated row masking a dropped one.
        // `idsOf` maps, so it already returns a fresh array — no copy needed before sort.
        expect(idsOf(sorted).sort(byLocale), `${field}/${direction}`).toStrictEqual(['a', 'b', 'c'])
      }
    }
  })

  it('groups unscored documents rather than ordering them against each other', () => {
    // Two rows nobody has scored tie, in both directions, so they stay in the order
    // they arrived rather than being ranked by a number neither has.
    for (const direction of ['asc', 'desc'] as const) {
      expect(() => sortRows([rowA, rowB], {}, 'priority_score', direction)).not.toThrow()
      expect(idsOf(sortRows([rowA, rowB], {}, 'priority_score', direction)), direction).toStrictEqual(['a', 'b'])
      expect(idsOf(sortRows([rowB, rowA], {}, 'impact', direction)), direction).toStrictEqual(['b', 'a'])
    }
  })

  it('does not rank a row with no team number against one that has', () => {
    // The comparator declines the comparison instead of substituting a value: which
    // of "scored" and "unscored" comes first is a grouping decision, and it is made
    // once for both directions. So the scored row leads either way, and it is the
    // grouping — not a comparison — that puts it there.
    const aggregates: Record<string, PrioritizationAggregate> = {
      b: aggregate({ impact: 5, reviewer_count: 2 }),
    }

    for (const direction of ['asc', 'desc'] as const) {
      expect(idsOf(sortRows([rowA, rowB], aggregates, 'priority_score', direction)), direction)
        .toStrictEqual(['b', 'a'])
    }
  })

  it('still orders created_at and title by the document, which no aggregate touches', () => {
    expect(idsOf(sortRows([rowB, rowA], {}, 'created_at', 'asc'))).toStrictEqual(['a', 'b'])
    expect(idsOf(sortRows([rowB, rowA], {}, 'title', 'asc'))).toStrictEqual(['a', 'b'])
  })
})

describe('sortRows applies direction without disturbing what has no number', () => {
  const rowC = rowView('c', 'Gamma', '2025-01-03')
  const titlesOf = (rows: readonly { title: string }[]) => rows.map((row) => row.title)

  const aggregates: Record<string, PrioritizationAggregate> = {
    a: aggregate({ impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, reviewer_count: 2 }),
    b: aggregate({ impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, reviewer_count: 2 }),
  }

  it('puts the highest team score first when descending', () => {
    expect(titlesOf(sortRows([rowA, rowB, rowC], aggregates, 'priority_score', 'desc')))
      .toStrictEqual(['Beta', 'Alpha', 'Gamma'])
  })

  it('keeps the unscored block at the BOTTOM ascending too, not at the top', () => {
    // A reader flipping to ascending is asking for the worst-RATED proposals.
    // "Nobody voted on this" is not a rating, so it is not a value the direction
    // toggle can invert — answering with a block of never-voted-on rows puts
    // unranked ones where the reader is looking for ranked.
    expect(titlesOf(sortRows([rowA, rowB, rowC], aggregates, 'priority_score', 'asc')))
      .toStrictEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('keeps an unreadable row in its OWN block, between ranked and unscored', () => {
    // Folding a marked row into the unscored block restated in the ordering the
    // conflation the row label refuses: "we could not find out" filed under "nobody
    // voted". It sits ABOVE the unscored block because it is the weaker claim — the
    // server said something about this document and it may be scored anywhere in the
    // ranked list, whereas "nobody voted" is settled.
    const rowD = rowView('d', 'Delta', '2025-01-04')
    const map: Record<string, TeamAggregateRow> = {
      a: aggregate({ impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, reviewer_count: 2 }),
      b: aggregate({ impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, reviewer_count: 2 }),
      c: UNREADABLE_ROW,
      // d absent: nobody voted.
    }

    // Arrival order deliberately interleaves the two number-less rows (Delta before
    // Gamma), so a rule that lumps them into ONE block would keep Delta first — the
    // blocks separating is what this asserts, not just "both at the bottom".
    expect(titlesOf(sortRows([rowD, rowC, rowB, rowA], map, 'priority_score', 'desc')))
      .toStrictEqual(['Beta', 'Alpha', 'Gamma', 'Delta'])
    // And neither block moves when the direction flips — only the ranked rows reorder.
    expect(titlesOf(sortRows([rowD, rowC, rowB, rowA], map, 'priority_score', 'asc')))
      .toStrictEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
  })

  it('does not reorder tied rows when the direction flips', () => {
    // `[...rows].sort(cmp).reverse()` reverses TIES as well as ranks, so two rows
    // the sort considers equal swapped places purely because the reader flipped the
    // direction. Negating the comparator instead leaves them where they were — and
    // the team view ties often, since impact and TTM order by a coarse 0–5 mean.
    const tied: Record<string, PrioritizationAggregate> = {
      a: aggregate({ impact: 3, reviewer_count: 2 }),
      b: aggregate({ impact: 3, reviewer_count: 2 }),
      c: aggregate({ impact: 5, reviewer_count: 2 }),
    }

    expect(titlesOf(sortRows([rowA, rowB, rowC], tied, 'impact', 'desc')))
      .toStrictEqual(['Gamma', 'Alpha', 'Beta'])
    expect(titlesOf(sortRows([rowA, rowB, rowC], tied, 'impact', 'asc')))
      .toStrictEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('orders by the composite the row PRINTS, so equal-looking rows tie', () => {
    // The sort reads `displayComposite`, not the raw weighted sum, for the reason
    // `displayComposite` exists: four means of 4 weigh to 3.9999999999999996 while
    // another mix weighs to 4.000000000000001, and both rows print `4.0`. Ordering
    // them by that invisible difference ranks two rows a reader sees as identical;
    // reading the printed value makes them tie, and a tie keeps arrival order in
    // BOTH directions.
    const equalOnScreen: Record<'a' | 'b', PrioritizationAggregate> = {
      a: aggregate({ impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 4, reviewer_count: 2 }),
      b: aggregate({ impact: 5, time_to_market: 4, confidence: 2, strategic_fit: 3, reviewer_count: 2 }),
    }
    const rawA = getTeamScore(equalOnScreen, 'a')
    const rawB = getTeamScore(equalOnScreen, 'b')

    // The premise, asserted rather than assumed: same printed number, different raw.
    expect([rawA?.displayComposite, rawB?.displayComposite]).toStrictEqual([4, 4])
    // Different unrounded sums behind the same printed 4.0 — read off the arithmetic,
    // since `TeamScore` carries only the rounded value.
    expect(calculatePriorityScore(equalOnScreen.a))
      .not.toBe(calculatePriorityScore(equalOnScreen.b))

    expect(titlesOf(sortRows([rowA, rowB], equalOnScreen, 'priority_score', 'desc')))
      .toStrictEqual(['Alpha', 'Beta'])
    expect(titlesOf(sortRows([rowB, rowA], equalOnScreen, 'priority_score', 'asc')))
      .toStrictEqual(['Beta', 'Alpha'])
  })

  it('ties the AXIS sorts on the printed value too, in both directions', () => {
    // The same rule as the composite, and reachable without floating-point dust: the
    // backend rounds each mean to TWO decimals (`round(…, 2)`) and the row prints ONE,
    // so 4.25 and 4.34 are ordinary output that print identically. Ordering them ranked
    // rows a reader sees as equal AND flipped the pair when the direction toggled —
    // the instability the comparator is negated rather than reversed to avoid.
    const equalOnScreen: Record<'a' | 'b', PrioritizationAggregate> = {
      a: aggregate({ impact: 4.25, time_to_market: 4.25, reviewer_count: 2 }),
      b: aggregate({ impact: 4.34, time_to_market: 4.34, reviewer_count: 2 }),
    }

    // The premise: same printed value, different mean on the wire. Read off the
    // AGGREGATE for the raw half, since `TeamScore` deliberately no longer carries an
    // unrounded copy — the input is where "these differ" actually lives.
    expect(equalOnScreen.a.impact).not.toBe(equalOnScreen.b.impact)
    expect(['a', 'b'].map((id) => getTeamScore(equalOnScreen, id)?.displayImpact)).toStrictEqual([4.3, 4.3])

    // Every field in both directions keeps the input order: a tie, not a flip.
    const orders = (['impact', 'time_to_market'] as const).flatMap((field) => (['desc', 'asc'] as const)
      .map((direction) => [field, direction, titlesOf(sortRows([rowA, rowB], equalOnScreen, field, direction))]))
    expect(orders).toStrictEqual([
      ['impact', 'desc', ['Alpha', 'Beta']],
      ['impact', 'asc', ['Alpha', 'Beta']],
      ['time_to_market', 'desc', ['Alpha', 'Beta']],
      ['time_to_market', 'asc', ['Alpha', 'Beta']],
    ])
  })

  it('still orders axis means that genuinely differ on screen', () => {
    // The positive control for the tie above: rounding must not flatten the sort.
    const different: Record<string, PrioritizationAggregate> = {
      a: aggregate({ impact: 2, time_to_market: 2, reviewer_count: 2 }),
      b: aggregate({ impact: 5, time_to_market: 5, reviewer_count: 2 }),
    }

    expect(titlesOf(sortRows([rowA, rowB], different, 'impact', 'desc'))).toStrictEqual(['Beta', 'Alpha'])
    expect(titlesOf(sortRows([rowA, rowB], different, 'impact', 'asc'))).toStrictEqual(['Alpha', 'Beta'])
  })

  it('leaves date and title sorts free of the unscored grouping', () => {
    // Those two read document fields every row has, so there is no unscored block
    // to pin and the direction reverses the whole list.
    expect(titlesOf(sortRows([rowB, rowA, rowC], aggregates, 'created_at', 'asc')))
      .toStrictEqual(['Alpha', 'Beta', 'Gamma'])
    expect(titlesOf(sortRows([rowB, rowA, rowC], aggregates, 'title', 'desc')))
      .toStrictEqual(['Gamma', 'Beta', 'Alpha'])
  })

  it('does not mutate the array it was given', () => {
    const rows = [rowA, rowB, rowC]
    sortRows(rows, aggregates, 'priority_score', 'desc')
    expect(titlesOf(rows)).toStrictEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('leaves the order alone when no team view arrived, rather than grouping everything', () => {
    // No number to rank by, and no honest grouping either: pinning every row as
    // "unscored" would order the backlog by a property no row has been shown to have.
    // True of a read that failed and of one still running — neither has said anything
    // about any document.
    for (const state of ['unavailable', 'loading'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(titlesOf(sortRows([rowB, rowA, rowC], state, 'priority_score', direction)), `${state} ${direction}`)
          .toStrictEqual(['Beta', 'Alpha', 'Gamma'])
      }
    }
  })

  it('still sorts by date and title when no team view arrived', () => {
    // Those read document fields, which neither state touches — so the sort a reader
    // can still trust keeps working.
    for (const state of ['unavailable', 'loading'] as const) {
      expect(titlesOf(sortRows([rowB, rowA, rowC], state, 'created_at', 'asc')), state)
        .toStrictEqual(['Alpha', 'Beta', 'Gamma'])
      expect(titlesOf(sortRows([rowB, rowA, rowC], state, 'title', 'desc')), state)
        .toStrictEqual(['Gamma', 'Beta', 'Alpha'])
    }
  })
})
