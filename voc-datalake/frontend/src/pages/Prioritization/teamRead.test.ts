/**
 * @fileoverview Tests for teamRead — the team half of the scores read.
 */
import { describe, it, expect } from 'vitest'
import { normalizeAggregates, teamAggregatesOf, teamReadDelivered, UNREADABLE_ROW, teamOrderingAvailable, uncountableTeamRead } from './teamRead'
import type { TeamAggregates, TeamAggregateRow } from './teamRead'
import { getTeamScore, getTeamView } from './teamScore'
import type { PrioritizationAggregate } from '../../api/projectTypes'
import { aggregate } from './prioritization-unit-fixtures'

describe('teamAggregatesOf reads what the query is HOLDING, not only what it is doing', () => {
  // `data` is undefined while the read is in flight, when it has failed, and when it
  // arrived carrying no `aggregates` at all — so it cannot decide this on its own, and
  // `?? {}` answered "nobody has scored anything" for all three.
  it('answers the map when the read arrived', () => {
    const aggregates = { d1: aggregate({ impact: 5, reviewer_count: 2 }) }

    expect(teamAggregatesOf({ failed: false, pending: false, aggregates })).toBe(aggregates)
  })

  it('answers an EMPTY map for a read that arrived carrying no aggregates', () => {
    // A deployment predating the field. That genuinely is "no team data yet", and every row
    // may honestly say so — which is why this case must stay distinct from the two below.
    // The empty map now comes from `normalizeAggregates(undefined)`, which is where absent
    // and unreadable are told apart; this function receives the result.
    expect(teamAggregatesOf({ failed: false, pending: false, aggregates: normalizeAggregates(undefined) }))
      .toStrictEqual({})
  })

  it('answers unavailable when a response ARRIVED with an unreadable team half', () => {
    // The one state that reaches the final arm: not failed, not pending, and nothing
    // readable. An empty map here would assert that nobody has voted on any document.
    expect(teamAggregatesOf({ failed: false, pending: false, aggregates: normalizeAggregates('boom') }))
      .toBe('unavailable')
  })

  it('answers unavailable for a failed read rather than an empty map', () => {
    expect(teamAggregatesOf({ failed: true, pending: false })).toBe('unavailable')
  })

  it('answers loading while the read is still in flight', () => {
    expect(teamAggregatesOf({ failed: false, pending: true })).toBe('loading')
  })

  it('prefers unavailable over loading for a failed read that is retrying', () => {
    // A query that failed and is retrying is pending again. "Reload the page" is the
    // more useful of the two things to say, and the panel above the list is already
    // saying it.
    expect(teamAggregatesOf({ failed: true, pending: true })).toBe('unavailable')
  })

  it('keeps a map it is still holding when a REFETCH fails', () => {
    // `failed` is the query's `isError`, which is true of a failed refetch too — and
    // TanStack Query keeps the last successful response in that state. Answering
    // 'unavailable' discarded team means the page had rendered a moment earlier: every
    // row dropped to "Team score unavailable", the cards dashed, the score sort stopped
    // and Save disabled. The page fires exactly this refetch after every save.
    const aggregates = { d1: aggregate({ impact: 5, reviewer_count: 3 }) }

    expect(teamAggregatesOf({ failed: true, pending: false, aggregates })).toBe(aggregates)
  })

  it('still answers unavailable for a failure with NO map to fall back on', () => {
    // The discriminating control for the case above: "keep what we are holding" must
    // not become "never say the read failed", which is all a first-load failure has.
    expect(teamAggregatesOf({ failed: true, pending: false, aggregates: undefined })).toBe('unavailable')
  })

  it('keeps a map it is still holding while a background refetch runs', () => {
    // The same argument one state along. A refetch in flight over cached data is not a
    // reason to blank a column that has an answer.
    const aggregates = { d1: aggregate({ impact: 5, reviewer_count: 3 }) }

    expect(teamAggregatesOf({ failed: false, pending: true, aggregates })).toBe(aggregates)
  })

  it('keeps an EMPTY map it is holding rather than calling it unavailable', () => {
    // A read that arrived saying "nobody has scored anything" is retained on the same
    // terms as a populated one: it is still the last thing the server told us, and it
    // is the answer the rows are already showing.
    const arrivedEmpty = {}

    expect(teamAggregatesOf({ failed: true, pending: false, aggregates: arrivedEmpty })).toBe(arrivedEmpty)
  })
})

describe('teamReadDelivered asks "did a map arrive" in one place', () => {
  // The binary question layered on the four-state union, which was spelled
  // `typeof aggregates === 'string'` at three call sites across two files: the sort,
  // the stats cards and the Save button. A fifth read state would leave all three
  // compiling and correct only by luck.
  it('is false for both read states', () => {
    expect(teamReadDelivered('loading')).toBe(false)
    expect(teamReadDelivered('unavailable')).toBe(false)
  })

  it('is true for an arrived map, including an empty one', () => {
    // Empty is an ANSWER — "nobody has scored anything" — so the sort groups by it,
    // the cards count it, and a save against it is honest.
    expect(teamReadDelivered({})).toBe(true)
    expect(teamReadDelivered({ d1: aggregate({ impact: 5, reviewer_count: 2 }) })).toBe(true)
  })

  it('narrows, so a caller that has asked can read the map as a map', () => {
    const aggregates: TeamAggregates = { d1: aggregate({ impact: 5, reviewer_count: 2 }) }

    // The `getTeamScore` call is the assertion: it does not accept `TeamAggregates`,
    // so this line only compiles because the predicate narrowed the union.
    expect(teamReadDelivered(aggregates) ? getTeamScore(aggregates, 'd1')?.displayImpact : null).toBe(5)
  })
})

describe('uncountableTeamRead treats a map of markers as the failure it is', () => {
  // The one spelling of "can the row-aggregating surfaces count this read" shared by
  // the stats cards and the sort hint. The discriminating case is the map-shaped
  // failure: a response whose EVERY named row is unreadable parses to a map, so
  // "did a map arrive" answers yes while the read says exactly as little as an
  // unreadable container — and counting it printed three confident zeros.
  it('answers the read state for the two container-level states, unchanged', () => {
    expect(uncountableTeamRead('unavailable')).toBe('unavailable')
    expect(uncountableTeamRead('loading')).toBe('loading')
  })

  it('answers unavailable for a non-empty map with not one readable row', () => {
    expect(uncountableTeamRead({ d1: UNREADABLE_ROW, d2: UNREADABLE_ROW })).toBe('unavailable')
  })

  it('counts an empty map — nobody voting is an answer, and zeros are then honest', () => {
    expect(uncountableTeamRead({})).toBeNull()
  })

  it('counts a map with even one readable row', () => {
    expect(uncountableTeamRead({
      d1: UNREADABLE_ROW,
      d2: aggregate({ impact: 3, reviewer_count: 2 }),
    })).toBeNull()
  })
})

describe('teamOrderingAvailable withdraws the ordering claim only where waiting cannot fix it', () => {
  // The predicate behind the permanently-visible hint that attributes the three score
  // sorts to the team's numbers. The two FALSE states are both settled: the read
  // failed, or it arrived and named documents without one readable number among them —
  // the second stopped reaching `'unavailable'` when the container-wide rule became
  // per-row marking, which is exactly how the hint came to describe an ordering that
  // was not happening.
  it('answers false when the read settled with nothing to order by', () => {
    expect(teamOrderingAvailable('unavailable')).toBe(false)
    expect(teamOrderingAvailable({ d1: UNREADABLE_ROW, d2: UNREADABLE_ROW })).toBe(false)
  })

  it('answers true while the read is running — it will order in a moment', () => {
    expect(teamOrderingAvailable('loading')).toBe(true)
  })

  it('answers true for an empty map: nobody voting is an answer, not a failure', () => {
    // Withdrawing the hint here would make a sentence about the BUTTONS flicker with
    // the backlog's voting state, and the hint is most use before the reader clicks.
    expect(teamOrderingAvailable({})).toBe(true)
  })

  it('answers true when even one row is readable', () => {
    expect(teamOrderingAvailable({
      d1: UNREADABLE_ROW,
      d2: aggregate({ impact: 3, reviewer_count: 2 }),
    })).toBe(true)
  })
})

describe('normalizeAggregates', () => {
  const complete = {
    impact: 4, time_to_market: 3, confidence: 2, strategic_fit: 1,
    reviewer_count: 2, score_spread: 1.5,
  }

  /**
   * `normalizeAggregates` narrowed to the map it answers for a readable container.
   *
   * Throws rather than asserting a type, so a case that starts answering `'unavailable'`
   * fails loudly here instead of silently reading as an empty map — which is the whole
   * distinction these tests are about.
   */
  const parsedAggregates = (raw: unknown): Record<string, TeamAggregateRow> => {
    const parsed = normalizeAggregates(raw)
    if (parsed === undefined) throw new Error('expected a map, got undefined')
    return parsed
  }

  /** A readable row out of an already-parsed map, narrowed. */
  const readable = (
    map: Record<string, TeamAggregateRow>, docId: string,
  ): PrioritizationAggregate => {
    const row = Object.hasOwn(map, docId) ? map[docId] : undefined
    if (row === undefined || row === UNREADABLE_ROW) throw new Error(`expected a readable row at ${docId}`)
    return row
  }


  it('keeps a complete row as sent', () => {
    expect(parsedAggregates({ d1: complete })).toStrictEqual({ d1: complete })
  })

  it('treats an ABSENT aggregates field as no team data, not an error', () => {
    // The field is optional on the wire: a deployment predating it sends no
    // `aggregates` at all, and every row then has to read as unscored.
    expect(parsedAggregates(undefined)).toStrictEqual({})
  })

  it('refuses to call an unreadable CONTAINER an empty map', () => {
    // An empty map is this page's assertion that nobody has voted on any document. A
    // `null`, a string, a number or an array is not evidence of that — it is a response we
    // could not read, so it answers `undefined` and `teamAggregatesOf` turns that into
    // `'unavailable'`. Same treatment the ballots half already had.
    for (const raw of [null, 'boom', 42, true, ['nope']]) {
      expect(normalizeAggregates(raw), JSON.stringify(raw)).toBeUndefined()
    }
    // And the pair that must stay apart: absent is "no team data yet", unreadable is not.
    expect(normalizeAggregates(undefined)).toStrictEqual({})
  })

  it('marks every row when nothing in the container could be read', () => {
    // A record IS readable, so the container check passes. Every row then being unreadable
    // used to compose back into `{}` — "nobody has voted on any document" on the strength of
    // a payload nothing in which could be read. Now each row says so for itself, which
    // produces the same page-level outcome without a special case.
    expect(parsedAggregates({ d1: 'junk', d2: { reviewer_count: 0 } }))
      .toStrictEqual({ d1: UNREADABLE_ROW, d2: UNREADABLE_ROW })
  })

  it('answers an empty map for an empty container', () => {
    // The server listing no scored documents is a real answer, not an unreadable one.
    expect(parsedAggregates({})).toStrictEqual({})
  })

  it('keeps a row whose axis is unreadable, with that axis at zero', () => {
    // A partial aggregate is still worth showing — the reviewer count and the
    // other axes are real — so an unreadable axis degrades rather than dropping the
    // row. `'high'` is not a number and expresses no position on the scale, so there
    // is nothing to clamp it to.
    const parsed = parsedAggregates({
      d1: { ...complete, impact: 'high', score_spread: 'wide' },
    })

    expect(readable(parsed, 'd1').impact).toBe(0)
    expect(readable(parsed, 'd1').score_spread).toBe(0)
    expect(readable(parsed, 'd1').reviewer_count).toBe(2)
  })

  it('marks a row with no usable reviewer count rather than inventing one', () => {
    // The count is the field that says somebody voted. An invented 1 would present a row
    // nobody scored as a scored one, and the backend never emits a zero-count row — it omits
    // the document instead. The row keeps its key and is marked unreadable, so the page says
    // "we could not find out" about that document rather than "nobody voted".
    for (const row of [{ ...complete, reviewer_count: 0 }, { ...complete, reviewer_count: 'two' }, { impact: 4 }]) {
      expect(parsedAggregates({ keep: complete, d1: row }), JSON.stringify(row))
        .toStrictEqual({ keep: complete, d1: UNREADABLE_ROW })
    }
  })

  it('marks a row that carries a count but no readable axis at all', () => {
    // The mirror of the reviewer-count rule, and the case the per-axis `.catch(0)` used to
    // admit on its own: a bare count parsed into an all-zeros aggregate and rendered
    // "0.0 · Reviewers 2" — a score nobody cast, dressed with a real count.
    expect(parsedAggregates({ keep: complete, d1: { reviewer_count: 2 } }))
      .toStrictEqual({ keep: complete, d1: UNREADABLE_ROW })
    expect(parsedAggregates({
      keep: complete,
      d1: {
        reviewer_count: 2, impact: 'high', time_to_market: 'slow', confidence: null, strategic_fit: [],
      },
    })).toStrictEqual({ keep: complete, d1: UNREADABLE_ROW })
  })

  it('CLAMPS an out-of-range axis onto the scale rather than zeroing it', () => {
    // Two rules, and only clamping makes them compose. The floor is about readability,
    // so an all-out-of-range row clears it — each axis IS a number. Zeroing them then
    // rendered the row the docstring forbids: `0.0 / 0.0 / 0.0`, "Reviewers 3", banded
    // "Low Priority", with a "Spread 2.0" badge over numbers the parse threw away —
    // and it sorted BELOW a row the team genuinely rated 1 across the board. Clamping
    // keeps the row derived from data somebody actually cast, the same reading the
    // backend's `validate_int` takes on the way in.
    const parsed = parsedAggregates({
      d1: {
        impact: 6, time_to_market: 6, confidence: 6, strategic_fit: 6,
        reviewer_count: 3, score_spread: 9,
      },
    })

    expect(parsed.d1).toStrictEqual({
      impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5,
      reviewer_count: 3, score_spread: 5,
    })
    // Named explicitly: the defect was a real reviewer count dressing an all-zeros
    // score, so "not zero" is the assertion, not merely "some number".
    expect(readable(parsed, 'd1').impact).not.toBe(0)
  })

  it('clamps a negative axis up to the bottom of the scale, not through it', () => {
    expect(readable(parsedAggregates({ d1: { impact: -3, reviewer_count: 2 } }), 'd1').impact).toBe(0)
    expect(readable(parsedAggregates({ d1: { ...complete, score_spread: -2 } }), 'd1').score_spread).toBe(0)
  })

  it('clamps each axis on its own, leaving the readable ones as sent', () => {
    // The positive control for clamping: it must not become "rewrite every axis".
    const parsed = parsedAggregates({
      d1: {
        impact: 4, time_to_market: 100, confidence: 2, strategic_fit: 1, reviewer_count: 3,
      },
    })

    expect(readable(parsed, 'd1').impact).toBe(4)
    expect(readable(parsed, 'd1').time_to_market).toBe(5)
    expect(readable(parsed, 'd1').confidence).toBe(2)
    expect(readable(parsed, 'd1').strategic_fit).toBe(1)
  })

  it('does not decide an out-of-range row by whether ONE axis happened to be in range', () => {
    // The inconsistency that gave the rule away: `{impact: 4, rest 6}` was kept with
    // the siblings degraded while `{all 6}` vanished — same data quality, opposite
    // outcome. Both are kept now, both clamped, and the reviewer count survives either
    // way.
    const mixed = parsedAggregates({
      d1: {
        impact: 4, time_to_market: 6, confidence: 6, strategic_fit: 6, reviewer_count: 3,
      },
    })
    const allOut = parsedAggregates({
      d1: {
        impact: 6, time_to_market: 6, confidence: 6, strategic_fit: 6, reviewer_count: 3,
      },
    })

    expect([Object.keys(mixed), Object.keys(allOut)]).toStrictEqual([['d1'], ['d1']])
    expect(readable(allOut, 'd1')).toMatchObject({ reviewer_count: 3, time_to_market: 5 })
    expect(readable(mixed, 'd1').time_to_market).toBe(5)
  })

  it('still drops a row whose axes are unreadable rather than merely out of range', () => {
    // The discriminating negative for the two cases above: relaxing the floor to
    // `z.number()` must not relax it to "anything at all". `NaN` and `Infinity` are
    // rejected too — `z.number()` refuses both — since neither is a slider position.
    expect(parsedAggregates({ keep: complete, d1: { reviewer_count: 2, impact: '6' } })).toStrictEqual({ keep: complete, d1: UNREADABLE_ROW })
    expect(parsedAggregates({ keep: complete, d1: { reviewer_count: 2, impact: true } })).toStrictEqual({ keep: complete, d1: UNREADABLE_ROW })
    expect(parsedAggregates({ keep: complete, d1: { reviewer_count: 2, impact: NaN } })).toStrictEqual({ keep: complete, d1: UNREADABLE_ROW })
    expect(parsedAggregates({ keep: complete, d1: { reviewer_count: 2, impact: Infinity } })).toStrictEqual({ keep: complete, d1: UNREADABLE_ROW })
  })

  it('keeps a row with one readable axis, degrading the rest', () => {
    // The positive control for the rule above, so "drop an axis-less row" cannot
    // silently become "drop any row with a zero in it". The backend legitimately
    // reports 0.0 for an axis nobody scored, so a partially-scored document really
    // does arrive with zeroed axes and is still worth showing.
    const parsed = parsedAggregates({ d1: { reviewer_count: 2, impact: 4 } })

    expect(parsed.d1).toStrictEqual({
      impact: 4, time_to_market: 0, confidence: 0, strategic_fit: 0,
      reviewer_count: 2, score_spread: 0,
    })
  })

  it('keeps a row the team genuinely scored zero on every axis', () => {
    // Indistinguishable from an unreadable row by value, so it is distinguished by
    // READABILITY: an explicit numeric 0 is data the backend sends, a string is not.
    const parsed = parsedAggregates({
      d1: {
        impact: 0, time_to_market: 0, confidence: 0, strategic_fit: 0,
        reviewer_count: 3, score_spread: 0,
      },
    })

    expect(readable(parsed, 'd1').reviewer_count).toBe(3)
  })

  it('marks only the unreadable rows, leaving their siblings scored', () => {
    // The discontinuity this replaced: dropping made the SAME bad row silent beside a good
    // one (rendered "Not scored yet") and reported when it was alone (the whole page
    // "unavailable"). Marking is one rule per row, so neither case depends on the other.
    const parsed = parsedAggregates({ d1: complete, d2: null, d3: 'nonsense' })

    expect(parsed).toStrictEqual({ d1: complete, d2: UNREADABLE_ROW, d3: UNREADABLE_ROW })
    expect(getTeamView(parsed, 'd2').kind).toBe('unavailable')
    expect(getTeamView(parsed, 'd1').kind).toBe('scored')
    // And a document the response never named is still unscored, not unavailable.
    expect(getTeamView(parsed, 'never-sent').kind).toBe('unscored')
  })

  it('never throws, whatever the wire sent', () => {
    // This feeds a react-query `select`: a throw would turn a readable response
    // into a failed query and fire the page's "scores could not be loaded" panel
    // over data that arrived fine. Asserted on `normalizeAggregates` itself, not through
    // the narrowing helper above — the helper throws BY DESIGN on `'unavailable'`, which
    // is a legitimate answer rather than a crash.
    for (const raw of [[], 'text', 42, true, { d1: [] }]) {
      expect(() => normalizeAggregates(raw), JSON.stringify(raw)).not.toThrow()
    }
  })
})
