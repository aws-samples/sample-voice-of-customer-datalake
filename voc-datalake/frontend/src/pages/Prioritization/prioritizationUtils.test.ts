/**
 * @fileoverview Tests for prioritizationUtils — safe score access and calculations.
 */
import { describe, it, expect } from 'vitest'
import i18n from 'i18next'
import { I18N_INIT_OPTIONS } from '../../i18n/options'
import {
  getScore, calculatePriorityScore, collectPRFAQs, DEFAULT_SCORE, isScorable,
  SCORABLE_TYPE_META, MAX_NOTE_LENGTH, overLongNoteDocuments, getTeamScore, normalizeAggregates,
  getPriorityLabel, priorityBand, reviewersDisagreed, sortPRFAQs, getTeamView, teamScoreOf,
  applyBallotEdits, withEditedField, teamAggregatesOf, teamReadDelivered,
} from './prioritizationUtils'
import type { TeamAggregates } from './prioritizationUtils'
import type { PrioritizationScore, PrioritizationAggregate, ProjectDocument } from '../../api/types'

describe('getScore', () => {
  it('returns stored score when document_id exists', () => {
    const scores: Record<string, PrioritizationScore> = {
      'd1': { document_id: 'd1', impact: 4, time_to_market: 2, confidence: 3, strategic_fit: 5, notes: 'test' },
    }

    const result = getScore(scores, 'd1')

    expect(result.impact).toBe(4)
    expect(result.notes).toBe('test')
  })

  it('returns DEFAULT_SCORE with document_id when key is missing', () => {
    const scores: Record<string, PrioritizationScore> = {}

    const result = getScore(scores, 'missing-id')

    expect(result.impact).toBe(0)
    expect(result.time_to_market).toBe(3)
    expect(result.confidence).toBe(0)
    expect(result.document_id).toBe('missing-id')
  })

  it('returns DEFAULT_SCORE for empty scores object', () => {
    const result = getScore({}, 'any-id')

    expect(result).toStrictEqual({ ...DEFAULT_SCORE, document_id: 'any-id' })
  })
})

describe('calculatePriorityScore', () => {
  it('returns 0 for default unscored item', () => {
    const score = { ...DEFAULT_SCORE, document_id: 'd1' }

    // impact=0*0.4 + ttm=3*0.3 + strategic=0*0.2 + confidence=0*0.1 = 0.9
    expect(calculatePriorityScore(score)).toBeCloseTo(0.9)
  })

  it('computes weighted score correctly', () => {
    const score: PrioritizationScore = {
      document_id: 'd1', impact: 5, time_to_market: 4, confidence: 3, strategic_fit: 2, notes: '',
    }

    // 5*0.4 + 4*0.3 + 2*0.2 + 3*0.1 = 2.0 + 1.2 + 0.4 + 0.3 = 3.9
    expect(calculatePriorityScore(score)).toBeCloseTo(3.9)
  })

  it('returns max score for all-5 ratings', () => {
    const score: PrioritizationScore = {
      document_id: 'd1', impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, notes: '',
    }

    expect(calculatePriorityScore(score)).toBeCloseTo(5.0)
  })
})

describe('isScorable', () => {
  it('returns true for prfaq documents', () => {
    const doc = { document_id: 'd1', document_type: 'prfaq' as const, title: 'A', content: '', created_at: '2025-01-01' }
    expect(isScorable(doc)).toBe(true)
  })

  it('returns true for prd documents', () => {
    const doc: ProjectDocument = { document_id: 'd2', document_type: 'prd', title: 'B', content: '', created_at: '2025-01-01' }
    expect(isScorable(doc)).toBe(true)
  })

  it('returns false for non-scorable document types', () => {
    const types: ProjectDocument['document_type'][] = ['research', 'custom', 'product_report', 'prototype']
    for (const document_type of types) {
      const doc: ProjectDocument = { document_id: 'dx', document_type, title: 'X', content: '', created_at: '2025-01-01' }
      expect(isScorable(doc)).toBe(false)
    }
  })
})

describe('collectPRFAQs', () => {
  it('returns empty array when no project details', () => {
    expect(collectPRFAQs(undefined, undefined)).toStrictEqual([])
    expect(collectPRFAQs([], [])).toStrictEqual([])
  })

  it('includes prfaq document types', () => {
    const details = [{
      documents: [
        { document_id: 'd1', document_type: 'prfaq' as const, title: 'A', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'research' as const, title: 'R', content: '', created_at: '2025-01-01' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', description: '', status: 'active' as const, created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(1)
    expect(result[0].document_id).toBe('d1')
    expect(result[0].document_type).toBe('prfaq')
    expect(result[0].project_name).toBe('P1')
  })

  it('includes prd document types', () => {
    const details = [{
      documents: [
        { document_id: 'd1', document_type: 'prd' as const, title: 'My PRD', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'research' as const, title: 'R', content: '', created_at: '2025-01-01' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', description: '', status: 'active' as const, created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(1)
    expect(result[0].document_id).toBe('d1')
    expect(result[0].document_type).toBe('prd')
    expect(result[0].project_name).toBe('P1')
  })

  it('collects both prd and prfaq from the same project', () => {
    const details = [{
      documents: [
        { document_id: 'd1', document_type: 'prfaq' as const, title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'prd' as const, title: 'Feature A PRD', content: '', created_at: '2025-01-02' },
        { document_id: 'd3', document_type: 'research' as const, title: 'Research', content: '', created_at: '2025-01-03' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', description: '', status: 'active' as const, created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(2)
    const ids = result.map((r) => r.document_id)
    expect(ids).toContain('d1')
    expect(ids).toContain('d2')
  })

  it('excludes non-scorable document types (research, custom, product_report, prototype)', () => {
    const details = [{
      documents: [
        { document_id: 'd1', document_type: 'research' as const, title: 'R', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'custom' as const, title: 'C', content: '', created_at: '2025-01-01' },
        { document_id: 'd3', document_type: 'product_report' as const, title: 'PR', content: '', created_at: '2025-01-01' },
        { document_id: 'd4', document_type: 'prototype' as const, title: 'Proto', content: '', created_at: '2025-01-01' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', description: '', status: 'active' as const, created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(0)
  })

  it('attaches the most-recent prototype to each scorable document', () => {
    const details = [{
      documents: [
        { document_id: 'prfaq1', document_type: 'prfaq' as const, title: 'A', content: '', created_at: '2025-01-01' },
        { document_id: 'proto-old', document_type: 'prototype' as const, title: 'Old Proto', content: '', created_at: '2025-01-10' },
        { document_id: 'proto-new', document_type: 'prototype' as const, title: 'New Proto', content: '', created_at: '2025-02-01' },
      ],
    }]
    const projects = [{ project_id: 'p1', name: 'P1', description: '', status: 'active' as const, created_at: '', updated_at: '', persona_count: 0, document_count: 0 }]

    const result = collectPRFAQs(details, projects)

    expect(result).toHaveLength(1)
    expect(result[0].prototype?.document_id).toBe('proto-new')
  })
})

const prfaqA = { document_id: 'a', project_id: 'p1', project_name: 'P1', document_type: 'prfaq' as const, title: 'Alpha', content: '', created_at: '2025-01-01' }
const prfaqB = { document_id: 'b', project_id: 'p1', project_name: 'P1', document_type: 'prfaq' as const, title: 'Beta', content: '', created_at: '2025-01-02' }

/** One document's team view, all four axes at the same value unless told otherwise. */
const aggregate = (
  fields: Partial<PrioritizationAggregate> & { reviewer_count: number },
): PrioritizationAggregate => ({
  impact: 0, time_to_market: 0, confidence: 0, strategic_fit: 0, score_spread: 0, ...fields,
})

describe('the sort orders by the TEAM aggregate, not the caller own ballot', () => {
  // Asserted through `sortPRFAQs`, which is the ONLY way the page reaches the
  // ordering. These cases used to call an exported `comparePRFAQs` wrapper that no
  // production code called, so the comparator the page actually uses could have
  // regressed with every one of them still green.
  const idsOf = (rows: readonly { document_id: string }[]) => rows.map((row) => row.document_id)

  it('sorts by the team mean impact when the field is impact', () => {
    const aggregates: Record<string, PrioritizationAggregate> = {
      a: aggregate({ impact: 2, reviewer_count: 2 }),
      b: aggregate({ impact: 5, reviewer_count: 2 }),
    }

    expect(idsOf(sortPRFAQs([prfaqA, prfaqB], aggregates, 'impact', 'asc'))).toEqual(['a', 'b'])
    expect(idsOf(sortPRFAQs([prfaqA, prfaqB], aggregates, 'impact', 'desc'))).toEqual(['b', 'a'])
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

    expect(idsOf(sortPRFAQs([prfaqB, prfaqA], aggregates, 'priority_score', 'desc'))).toEqual(['a', 'b'])
  })

  it('ranks an unscored document BELOW one the team scored low, rather than above it', () => {
    // The defect this replaces: DEFAULT_SCORE composites to 0.9 (time_to_market 3
    // at weight 0.3), so an untouched proposal outranked one the team had looked
    // at and rated 1 across the board — composite 1.0. Absent from the aggregate
    // means nobody voted, which is not a low score.
    //
    // Asserted through `sortPRFAQs`, which owns the unscored block: the comparator
    // answers 0 for a row with no number on the axis (see below), and it is the sort
    // that then pins those rows to the bottom — in both directions, so this holds
    // ascending too rather than only in the default view.
    const aggregates: Record<string, PrioritizationAggregate> = {
      b: aggregate({ impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, reviewer_count: 1 }),
    }

    for (const direction of ['asc', 'desc'] as const) {
      const order = sortPRFAQs([prfaqA, prfaqB], aggregates, 'priority_score', direction)
      expect(order.map((row) => row.document_id), direction).toEqual(['b', 'a'])
    }
  })

  it('groups unscored documents rather than ordering them against each other', () => {
    // Two rows nobody has scored tie, in both directions, so they stay in the order
    // they arrived rather than being ranked by a number neither has.
    for (const direction of ['asc', 'desc'] as const) {
      expect(() => sortPRFAQs([prfaqA, prfaqB], {}, 'priority_score', direction)).not.toThrow()
      expect(idsOf(sortPRFAQs([prfaqA, prfaqB], {}, 'priority_score', direction)), direction).toEqual(['a', 'b'])
      expect(idsOf(sortPRFAQs([prfaqB, prfaqA], {}, 'impact', direction)), direction).toEqual(['b', 'a'])
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
      expect(idsOf(sortPRFAQs([prfaqA, prfaqB], aggregates, 'priority_score', direction)), direction)
        .toEqual(['b', 'a'])
    }
  })

  it('still orders created_at and title by the document, which no aggregate touches', () => {
    expect(idsOf(sortPRFAQs([prfaqB, prfaqA], {}, 'created_at', 'asc'))).toEqual(['a', 'b'])
    expect(idsOf(sortPRFAQs([prfaqB, prfaqA], {}, 'title', 'asc'))).toEqual(['a', 'b'])
  })
})

describe('getTeamScore', () => {
  it('composites the team means through the same weights the page sorts by', () => {
    // 5*0.4 + 4*0.3 + 2*0.2 + 3*0.1 = 3.9 — the calculatePriorityScore case above,
    // reached through the aggregate. The displayed number and the sort order are
    // then the same arithmetic by construction.
    const team = getTeamScore({
      d1: aggregate({ impact: 5, time_to_market: 4, strategic_fit: 2, confidence: 3, reviewer_count: 4 }),
    }, 'd1')

    expect(team?.composite).toBeCloseTo(3.9)
    expect(team?.reviewerCount).toBe(4)
  })

  it('answers null for a document nobody has scored, not a zero row', () => {
    // Absence from the map IS the unscored signal: the backend omits a document
    // with no votes rather than emitting a zero mean. A zeroed record here would
    // make "nobody looked" indistinguishable from "the team rated it lowest".
    expect(getTeamScore({}, 'd1')).toBeNull()
  })

  it('does not let an inherited property name answer for a document', () => {
    expect(getTeamScore({}, 'toString')).toBeNull()
  })

  it('withholds the spread for a single ballot instead of reporting agreement', () => {
    // One reviewer yields a mean equal to that ballot and a spread of 0.0, which
    // reads as consensus. Null so the row can say "one person looked" instead.
    const alone = getTeamScore({ d1: aggregate({ impact: 5, reviewer_count: 1 }) }, 'd1')
    expect(alone?.spread).toBeNull()
    expect(alone?.reviewerCount).toBe(1)
  })

  it('reports a real spread once more than one reviewer has voted', () => {
    // The positive control for the case above: withholding must be about the
    // reviewer count, not about the spread never surfacing at all.
    const team = getTeamScore({ d1: aggregate({ impact: 5, reviewer_count: 3, score_spread: 1.6 }) }, 'd1')
    expect(team?.spread).toBeCloseTo(1.6)
  })

  it('reports zero spread as agreement when several reviewers voted', () => {
    const team = getTeamScore({ d1: aggregate({ impact: 5, reviewer_count: 3, score_spread: 0 }) }, 'd1')
    expect(team?.spread).toBe(0)
  })

  it('carries the composite rounded to the decimal the row prints', () => {
    // Four means of 4 weigh to 3.9999999999999996 in IEEE-754. The row prints
    // `4.0`, so anything classifying the row has to read the same 4 — otherwise the
    // band and the number beside it describe different values.
    const team = getTeamScore({
      d1: aggregate({ impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 4, reviewer_count: 2 }),
    }, 'd1')

    expect(team?.composite).toBeLessThan(4)
    expect(team?.displayComposite).toBe(4)
  })
})

describe('reviewersDisagreed', () => {
  // One predicate, so the badge on the collapsed row and the pointer to the notes
  // inside it cannot answer differently about the same document.
  it('is false when nobody has scored the document', () => {
    expect(reviewersDisagreed(null)).toBe(false)
  })

  it('is false for a single ballot, which has nothing to disagree with', () => {
    expect(reviewersDisagreed(getTeamScore({ d1: aggregate({ impact: 5, reviewer_count: 1, score_spread: 3 }) }, 'd1'))).toBe(false)
  })

  it('is false when the comparable reviewers agreed', () => {
    expect(reviewersDisagreed(getTeamScore({ d1: aggregate({ impact: 5, reviewer_count: 3, score_spread: 0 }) }, 'd1'))).toBe(false)
  })

  it('is true once the reviewers are genuinely apart', () => {
    expect(reviewersDisagreed(getTeamScore({ d1: aggregate({ impact: 5, reviewer_count: 3, score_spread: 1.8 }) }, 'd1'))).toBe(true)
  })
})

describe('priorityBand', () => {
  const bandOf = (fields: Partial<PrioritizationAggregate> & { reviewer_count: number }) =>
    priorityBand(getTeamView({ d1: aggregate(fields) }, 'd1'))

  const uniform = (value: number) => ({
    impact: value, time_to_market: value, confidence: value, strategic_fit: value, reviewer_count: 3,
  })

  it('names an unscored document, and ONLY an unscored one, as unbanded', () => {
    expect(priorityBand(getTeamView({}, 'd1'))).toBe('none')
  })

  it('names a document whose team view could not be READ as neither', () => {
    // A failed read is not a fact about the document. Banding it 'none' put the
    // words "Not Scored" on a row whose votes simply could not be fetched, and made
    // the stats cards count the whole backlog as unscored.
    expect(priorityBand(getTeamView('unavailable', 'd1'))).toBe('unavailable')
    expect(priorityBand(getTeamView('unavailable', 'd1'))).not.toBe(priorityBand(getTeamView({}, 'd1')))
  })

  it('bands a read still in flight as neither too, distinctly from a failed one', () => {
    // Also not a fact about the document, and not the same fact about the read: one
    // clears itself, the other asks the reader to reload.
    expect(priorityBand(getTeamView('loading', 'd1'))).toBe('loading')
    expect(priorityBand(getTeamView('loading', 'd1'))).not.toBe(priorityBand(getTeamView({}, 'd1')))
    expect(priorityBand(getTeamView('loading', 'd1'))).not.toBe(priorityBand(getTeamView('unavailable', 'd1')))
  })

  it('bands a unanimously-lowest score as low rather than as unscored', () => {
    // The defect this closes: the band used to read `team?.composite ?? 0`, so a
    // proposal three reviewers all rated 1 showed `1.0`, `Reviewers 3` and the label
    // "Not Scored" — the same words as a document nobody had opened. "Scored low"
    // and "nobody looked" have to stay distinct in the row, not only in the sort.
    expect(bandOf(uniform(1))).toBe('low')
    expect(bandOf(uniform(1))).not.toBe(priorityBand(getTeamView({}, 'd1')))
  })

  it('bands a composite that only ROUNDS to the threshold with the threshold', () => {
    // 4 on every axis weighs to 3.9999999999999996: printed `4.0`, and formerly
    // banded Medium against an unrounded `>= 4`. The band reads the printed value.
    expect(bandOf(uniform(4))).toBe('high')
    expect(bandOf(uniform(3))).toBe('medium')
    // And 3.94 still prints 3.9, so it is Medium — the rounding is to one decimal,
    // not to the nearest integer.
    expect(bandOf({ impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 3.7, reviewer_count: 3 })).toBe('medium')
  })
})

describe('getPriorityLabel', () => {
  const t = i18n.getFixedT(null, 'prioritization')

  it('gives a scored-low document a different label from an unscored one', () => {
    const scoredLow = getPriorityLabel(getTeamView({
      d1: aggregate({ impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, reviewer_count: 3 }),
    }, 'd1'), t)

    expect(scoredLow.label).toBe('Low Priority')
    expect(scoredLow.label).not.toBe(getPriorityLabel(getTeamView({}, 'd1'), t).label)
    expect(getPriorityLabel(getTeamView({}, 'd1'), t).label).toBe('Not Scored')
  })

  it('does not tell a reader nobody voted when the read simply failed', () => {
    // Four labels for four states. "Not Scored" is a claim about the document and
    // must not be made on its behalf by a request that never arrived.
    const unavailable = getPriorityLabel(getTeamView('unavailable', 'd1'), t)

    expect(unavailable.label).toBe('Team score unavailable')
    expect(unavailable.label).not.toBe(getPriorityLabel(getTeamView({}, 'd1'), t).label)
  })

  it('does not tell a reader nobody voted while the read is still running', () => {
    const loading = getPriorityLabel(getTeamView('loading', 'd1'), t)

    expect(loading.label).toBe('Loading team score')
    expect(loading.label).not.toBe(getPriorityLabel(getTeamView({}, 'd1'), t).label)
    // Resolves to real text rather than the raw key path, which is what the
    // namespace-qualified `i18nKey` in `BAND_STYLE` exists to guarantee.
    expect(loading.label).not.toContain('team.loading')
  })

  it('labels a team that unanimously scored 4 as high, beside the 4.0 the row prints', () => {
    const aggregates = {
      d1: aggregate({ impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 4, reviewer_count: 2 }),
    }

    expect(getTeamScore(aggregates, 'd1')?.displayComposite.toFixed(1)).toBe('4.0')
    expect(getPriorityLabel(getTeamView(aggregates, 'd1'), t).label).toBe('High Priority')
  })
})

describe('teamAggregatesOf reads what the query is HOLDING, not only what it is doing', () => {
  // `data` is undefined while the read is in flight, when it has failed, and when it
  // arrived carrying no `aggregates` at all — so it cannot decide this on its own, and
  // `?? {}` answered "nobody has scored anything" for all three.
  it('answers the map when the read arrived', () => {
    const aggregates = { d1: aggregate({ impact: 5, reviewer_count: 2 }) }

    expect(teamAggregatesOf({ failed: false, pending: false, aggregates })).toBe(aggregates)
  })

  it('answers an EMPTY map for a read that arrived carrying no aggregates', () => {
    // A deployment predating the field. That genuinely is "no team data yet", and every
    // row may honestly say so — which is why this case must stay distinct from the two
    // below rather than being folded in with them.
    expect(teamAggregatesOf({ failed: false, pending: false })).toEqual({})
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
    expect(teamReadDelivered(aggregates) ? getTeamScore(aggregates, 'd1')?.impact : null).toBe(5)
  })
})

describe('getTeamView tells three states apart', () => {
  // The distinction the page turns on: "the team rated this low", "nobody has voted"
  // and "we could not find out" are three different statements, and only the first
  // two are about the document.
  it('reads a document in the map as scored', () => {
    const view = getTeamView({ d1: aggregate({ impact: 5, reviewer_count: 2 }) }, 'd1')

    expect(view.kind).toBe('scored')
    expect(teamScoreOf(view)?.impact).toBe(5)
  })

  it('reads a document absent from an arrived map as unscored', () => {
    expect(getTeamView({}, 'd1').kind).toBe('unscored')
    expect(teamScoreOf(getTeamView({}, 'd1'))).toBeNull()
  })

  it('reads a FAILED read as unavailable, for every document', () => {
    // Not per document: a missing key in a map that never arrived says nothing about
    // the key. So the failure has to be answered before the lookup, or a row would
    // report "nobody voted" on the strength of a response that does not exist.
    expect(getTeamView('unavailable', 'd1').kind).toBe('unavailable')
    expect(getTeamView('unavailable', 'anything-at-all').kind).toBe('unavailable')
    expect(teamScoreOf(getTeamView('unavailable', 'd1'))).toBeNull()
  })

  it('reads a read still IN FLIGHT as loading, not as an unscored backlog', () => {
    // The same argument one state along, and the state the page was missing: the read
    // scans a whole partition while the project reads are a parallel fan-out, so the
    // rows render before it lands. `{}` there made every row say "Not scored yet" and
    // invite a first ballot, with no error panel on screen because nothing had failed.
    expect(getTeamView('loading', 'd1').kind).toBe('loading')
    expect(teamScoreOf(getTeamView('loading', 'd1'))).toBeNull()
  })

  it('tells loading, failed and genuinely-empty apart rather than collapsing them', () => {
    // Three distinct kinds, because they license three different sentences: "it will
    // fill in", "reload the page", "cast the first ballot".
    const kinds = ['loading', 'unavailable'] as const
    expect(new Set([...kinds.map((s) => getTeamView(s, 'd1').kind), getTeamView({}, 'd1').kind]).size)
      .toBe(3)
  })
})

describe('sortPRFAQs applies direction without disturbing what has no number', () => {
  const prfaqC = { document_id: 'c', project_id: 'p1', project_name: 'P1', document_type: 'prfaq' as const, title: 'Gamma', content: '', created_at: '2025-01-03' }
  const titlesOf = (rows: readonly { title: string }[]) => rows.map((row) => row.title)

  const aggregates: Record<string, PrioritizationAggregate> = {
    a: aggregate({ impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, reviewer_count: 2 }),
    b: aggregate({ impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, reviewer_count: 2 }),
  }

  it('puts the highest team score first when descending', () => {
    expect(titlesOf(sortPRFAQs([prfaqA, prfaqB, prfaqC], aggregates, 'priority_score', 'desc')))
      .toEqual(['Beta', 'Alpha', 'Gamma'])
  })

  it('keeps the unscored block at the BOTTOM ascending too, not at the top', () => {
    // A reader flipping to ascending is asking for the worst-RATED proposals.
    // "Nobody voted on this" is not a rating, so it is not a value the direction
    // toggle can invert — answering with a block of never-voted-on rows puts
    // unranked ones where the reader is looking for ranked.
    expect(titlesOf(sortPRFAQs([prfaqA, prfaqB, prfaqC], aggregates, 'priority_score', 'asc')))
      .toEqual(['Alpha', 'Beta', 'Gamma'])
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

    expect(titlesOf(sortPRFAQs([prfaqA, prfaqB, prfaqC], tied, 'impact', 'desc')))
      .toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(titlesOf(sortPRFAQs([prfaqA, prfaqB, prfaqC], tied, 'impact', 'asc')))
      .toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('orders by the composite the row PRINTS, so equal-looking rows tie', () => {
    // The sort reads `displayComposite`, not the raw weighted sum, for the reason
    // `displayComposite` exists: four means of 4 weigh to 3.9999999999999996 while
    // another mix weighs to 4.000000000000001, and both rows print `4.0`. Ordering
    // them by that invisible difference ranks two rows a reader sees as identical;
    // reading the printed value makes them tie, and a tie keeps arrival order in
    // BOTH directions.
    const equalOnScreen: Record<string, PrioritizationAggregate> = {
      a: aggregate({ impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 4, reviewer_count: 2 }),
      b: aggregate({ impact: 5, time_to_market: 4, confidence: 2, strategic_fit: 3, reviewer_count: 2 }),
    }
    const rawA = getTeamScore(equalOnScreen, 'a')
    const rawB = getTeamScore(equalOnScreen, 'b')

    // The premise, asserted rather than assumed: same printed number, different raw.
    expect(rawA?.displayComposite).toBe(4)
    expect(rawB?.displayComposite).toBe(4)
    expect(rawA?.composite).not.toBe(rawB?.composite)

    expect(titlesOf(sortPRFAQs([prfaqA, prfaqB], equalOnScreen, 'priority_score', 'desc')))
      .toEqual(['Alpha', 'Beta'])
    expect(titlesOf(sortPRFAQs([prfaqB, prfaqA], equalOnScreen, 'priority_score', 'asc')))
      .toEqual(['Beta', 'Alpha'])
  })

  it('leaves date and title sorts free of the unscored grouping', () => {
    // Those two read document fields every row has, so there is no unscored block
    // to pin and the direction reverses the whole list.
    expect(titlesOf(sortPRFAQs([prfaqB, prfaqA, prfaqC], aggregates, 'created_at', 'asc')))
      .toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(titlesOf(sortPRFAQs([prfaqB, prfaqA, prfaqC], aggregates, 'title', 'desc')))
      .toEqual(['Gamma', 'Beta', 'Alpha'])
  })

  it('does not mutate the array it was given', () => {
    const rows = [prfaqA, prfaqB, prfaqC]
    sortPRFAQs(rows, aggregates, 'priority_score', 'desc')
    expect(titlesOf(rows)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('leaves the order alone when no team view arrived, rather than grouping everything', () => {
    // No number to rank by, and no honest grouping either: pinning every row as
    // "unscored" would order the backlog by a property no row has been shown to have.
    // True of a read that failed and of one still running — neither has said anything
    // about any document.
    for (const state of ['unavailable', 'loading'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(titlesOf(sortPRFAQs([prfaqB, prfaqA, prfaqC], state, 'priority_score', direction)), `${state} ${direction}`)
          .toEqual(['Beta', 'Alpha', 'Gamma'])
      }
    }
  })

  it('still sorts by date and title when no team view arrived', () => {
    // Those read document fields, which neither state touches — so the sort a reader
    // can still trust keeps working.
    for (const state of ['unavailable', 'loading'] as const) {
      expect(titlesOf(sortPRFAQs([prfaqB, prfaqA, prfaqC], state, 'created_at', 'asc')), state)
        .toEqual(['Alpha', 'Beta', 'Gamma'])
      expect(titlesOf(sortPRFAQs([prfaqB, prfaqA, prfaqC], state, 'title', 'desc')), state)
        .toEqual(['Gamma', 'Beta', 'Alpha'])
    }
  })
})

describe('a pending edit carries only the fields the reader set', () => {
  // The defect: an edit seeded from `getScore` — and so from `DEFAULT_SCORE` on a row
  // with no stored ballot — sent all four axes when the reader moved one slider, two
  // of them as a `0` the slider (min=1) cannot express. The backend counts an
  // explicit value as a vote and averages each axis over the reviewers who cast one,
  // so those fabricated zeros moved the TEAM means this page displays and sorts by.
  it('records one axis without inventing the other three', () => {
    const edit = withEditedField({ document_id: 'd1' }, 'impact', 5)

    expect(edit).toEqual({ document_id: 'd1', impact: 5 })
    // Named explicitly, because "absent" is what the route reads as "leave it alone"
    // and a 0 here is what it reads as a vote.
    expect('time_to_market' in edit).toBe(false)
    expect('confidence' in edit).toBe(false)
    expect('strategic_fit' in edit).toBe(false)
    expect('notes' in edit).toBe(false)
  })

  it('accumulates the fields a reader sets across several interactions', () => {
    // The positive control: omitting untouched axes must not become omitting touched
    // ones, or a reviewer's second slider would silently not save.
    const edit = withEditedField(
      withEditedField({ document_id: 'd1' }, 'impact', 5), 'confidence', 2,
    )

    expect(edit).toEqual({ document_id: 'd1', impact: 5, confidence: 2 })
  })

  it('keeps an axis a number and a note a string', () => {
    // The slider hands over a string from the DOM event; a note stored as a number,
    // or an axis as a string, is refused by the API rather than caught here.
    expect(withEditedField({ document_id: 'd1' }, 'impact', '4').impact).toBe(4)
    expect(withEditedField({ document_id: 'd1' }, 'notes', 'why').notes).toBe('why')
  })

  it('shows a partial edit over the stored ballot without blanking what it omits', () => {
    // The sliders read this. A `{...saved, ...edit}` spread would let an axis the edit
    // says nothing about overwrite a saved one with `undefined`, blanking a slider
    // showing a score the reviewer had stored.
    const merged = applyBallotEdits({
      d1: {
        document_id: 'd1', impact: 2, time_to_market: 3, confidence: 4, strategic_fit: 5, notes: 'kept',
      },
    }, { d1: { document_id: 'd1', impact: 5 } })

    expect(merged.d1).toEqual({
      document_id: 'd1', impact: 5, time_to_market: 3, confidence: 4, strategic_fit: 5, notes: 'kept',
    })
  })

  it('falls back to the display defaults for a row with no stored ballot', () => {
    // The sliders still need four numbers to render. That seeding is a DISPLAY
    // concern and stays here, on the way to the screen — not in the edit, which is
    // what gets sent.
    const merged = applyBallotEdits({}, { d1: { document_id: 'd1', impact: 5 } })

    expect(merged.d1).toEqual({
      ...DEFAULT_SCORE, document_id: 'd1', impact: 5,
    })
  })

  it('leaves rows nobody edited exactly as they were saved', () => {
    const saved = {
      d1: {
        document_id: 'd1', impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, notes: '',
      },
    }

    expect(applyBallotEdits(saved, {}).d1).toEqual(saved.d1)
  })
})

describe('normalizeAggregates', () => {
  const complete = {
    impact: 4, time_to_market: 3, confidence: 2, strategic_fit: 1,
    reviewer_count: 2, score_spread: 1.5,
  }

  it('keeps a complete row as sent', () => {
    expect(normalizeAggregates({ d1: complete })).toEqual({ d1: complete })
  })

  it('treats an absent aggregates field as no team data, not an error', () => {
    // The field is optional on the wire: a deployment predating it sends no
    // `aggregates` at all, and every row then has to read as unscored.
    expect(normalizeAggregates(undefined)).toEqual({})
    expect(normalizeAggregates(null)).toEqual({})
  })

  it('keeps a row whose axis is unreadable, with that axis at zero', () => {
    // A partial aggregate is still worth showing — the reviewer count and the
    // other axes are real — so an unreadable axis degrades rather than dropping the
    // row. `'high'` is not a number and expresses no position on the scale, so there
    // is nothing to clamp it to.
    const parsed = normalizeAggregates({
      d1: { ...complete, impact: 'high', score_spread: 'wide' },
    })

    expect(parsed.d1.impact).toBe(0)
    expect(parsed.d1.score_spread).toBe(0)
    expect(parsed.d1.reviewer_count).toBe(2)
  })

  it('drops a row with no usable reviewer count rather than inventing one', () => {
    // The count is the field that says somebody voted. An invented 1 would
    // present a row nobody scored as a scored one, and the backend never emits a
    // zero-count row — it omits the document instead.
    expect(normalizeAggregates({ d1: { ...complete, reviewer_count: 0 } })).toEqual({})
    expect(normalizeAggregates({ d1: { ...complete, reviewer_count: 'two' } })).toEqual({})
    expect(normalizeAggregates({ d1: { impact: 4 } })).toEqual({})
  })

  it('drops a row that carries a count but no readable axis at all', () => {
    // The mirror of the reviewer-count rule, and the case the per-axis `.catch(0)`
    // used to admit on its own: a bare count parsed into an all-zeros aggregate and
    // rendered "0.0 · Reviewers 2" — a score nobody cast, dressed with a real count.
    // A dropped row lands in the "nobody scored this" state the page renders
    // honestly.
    expect(normalizeAggregates({ d1: { reviewer_count: 2 } })).toEqual({})
    expect(normalizeAggregates({
      d1: {
        reviewer_count: 2, impact: 'high', time_to_market: 'slow', confidence: null, strategic_fit: [],
      },
    })).toEqual({})
  })

  it('CLAMPS an out-of-range axis onto the scale rather than zeroing it', () => {
    // Two rules, and only clamping makes them compose. The floor is about readability,
    // so an all-out-of-range row clears it — each axis IS a number. Zeroing them then
    // rendered the row the docstring forbids: `0.0 / 0.0 / 0.0`, "Reviewers 3", banded
    // "Low Priority", with a "Spread 2.0" badge over numbers the parse threw away —
    // and it sorted BELOW a row the team genuinely rated 1 across the board. Clamping
    // keeps the row derived from data somebody actually cast, the same reading the
    // backend's `validate_int` takes on the way in.
    const parsed = normalizeAggregates({
      d1: {
        impact: 6, time_to_market: 6, confidence: 6, strategic_fit: 6,
        reviewer_count: 3, score_spread: 9,
      },
    })

    expect(parsed.d1).toEqual({
      impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5,
      reviewer_count: 3, score_spread: 5,
    })
    // Named explicitly: the defect was a real reviewer count dressing an all-zeros
    // score, so "not zero" is the assertion, not merely "some number".
    expect(parsed.d1.impact).not.toBe(0)
  })

  it('clamps a negative axis up to the bottom of the scale, not through it', () => {
    expect(normalizeAggregates({ d1: { impact: -3, reviewer_count: 2 } }).d1.impact).toBe(0)
    expect(normalizeAggregates({ d1: { ...complete, score_spread: -2 } }).d1.score_spread).toBe(0)
  })

  it('clamps each axis on its own, leaving the readable ones as sent', () => {
    // The positive control for clamping: it must not become "rewrite every axis".
    const parsed = normalizeAggregates({
      d1: {
        impact: 4, time_to_market: 100, confidence: 2, strategic_fit: 1, reviewer_count: 3,
      },
    })

    expect(parsed.d1.impact).toBe(4)
    expect(parsed.d1.time_to_market).toBe(5)
    expect(parsed.d1.confidence).toBe(2)
    expect(parsed.d1.strategic_fit).toBe(1)
  })

  it('does not decide an out-of-range row by whether ONE axis happened to be in range', () => {
    // The inconsistency that gave the rule away: `{impact: 4, rest 6}` was kept with
    // the siblings degraded while `{all 6}` vanished — same data quality, opposite
    // outcome. Both are kept now, both clamped, and the reviewer count survives either
    // way.
    const mixed = normalizeAggregates({
      d1: {
        impact: 4, time_to_market: 6, confidence: 6, strategic_fit: 6, reviewer_count: 3,
      },
    })
    const allOut = normalizeAggregates({
      d1: {
        impact: 6, time_to_market: 6, confidence: 6, strategic_fit: 6, reviewer_count: 3,
      },
    })

    expect(Object.keys(mixed)).toEqual(['d1'])
    expect(Object.keys(allOut)).toEqual(['d1'])
    expect(allOut.d1.reviewer_count).toBe(3)
    expect(mixed.d1.time_to_market).toBe(5)
    expect(allOut.d1.time_to_market).toBe(5)
  })

  it('still drops a row whose axes are unreadable rather than merely out of range', () => {
    // The discriminating negative for the two cases above: relaxing the floor to
    // `z.number()` must not relax it to "anything at all". `NaN` and `Infinity` are
    // rejected too — `z.number()` refuses both — since neither is a slider position.
    expect(normalizeAggregates({ d1: { reviewer_count: 2, impact: '6' } })).toEqual({})
    expect(normalizeAggregates({ d1: { reviewer_count: 2, impact: true } })).toEqual({})
    expect(normalizeAggregates({ d1: { reviewer_count: 2, impact: NaN } })).toEqual({})
    expect(normalizeAggregates({ d1: { reviewer_count: 2, impact: Infinity } })).toEqual({})
  })

  it('keeps a row with one readable axis, degrading the rest', () => {
    // The positive control for the rule above, so "drop an axis-less row" cannot
    // silently become "drop any row with a zero in it". The backend legitimately
    // reports 0.0 for an axis nobody scored, so a partially-scored document really
    // does arrive with zeroed axes and is still worth showing.
    const parsed = normalizeAggregates({ d1: { reviewer_count: 2, impact: 4 } })

    expect(parsed.d1).toEqual({
      impact: 4, time_to_market: 0, confidence: 0, strategic_fit: 0,
      reviewer_count: 2, score_spread: 0,
    })
  })

  it('keeps a row the team genuinely scored zero on every axis', () => {
    // Indistinguishable from an unreadable row by value, so it is distinguished by
    // READABILITY: an explicit numeric 0 is data the backend sends, a string is not.
    const parsed = normalizeAggregates({
      d1: {
        impact: 0, time_to_market: 0, confidence: 0, strategic_fit: 0,
        reviewer_count: 3, score_spread: 0,
      },
    })

    expect(parsed.d1.reviewer_count).toBe(3)
  })

  it('drops only the unreadable row, keeping its siblings', () => {
    const parsed = normalizeAggregates({ d1: complete, d2: null, d3: 'nonsense' })

    expect(Object.keys(parsed)).toEqual(['d1'])
  })

  it('never throws, whatever the wire sent', () => {
    // This feeds a react-query `select`: a throw would turn a readable response
    // into a failed query and fire the page's "scores could not be loaded" panel
    // over data that arrived fine.
    for (const raw of [[], 'text', 42, true, { d1: [] }]) {
      expect(() => normalizeAggregates(raw)).not.toThrow()
    }
  })
})

describe('StatsCards regression: scores with missing document_id', () => {
  /**
   * Regression test for: TypeError: Cannot read properties of undefined (reading 'impact')
   * When scores object doesn't contain an entry for a PR/FAQ's document_id,
   * direct access scores[id].impact crashes. getScore() must be used instead.
   */
  it('getScore does not crash when accessing impact on missing score', () => {
    const scores: Record<string, PrioritizationScore> = {}
    const docId = 'nonexistent-doc'

    // This is what the buggy code did: scores[docId].impact
    // This is what the fixed code does:
    const score = getScore(scores, docId)
    expect(score.impact).toBe(0)
  })

  it('calculatePriorityScore works with getScore fallback', () => {
    const scores: Record<string, PrioritizationScore> = {}

    const score = getScore(scores, 'missing')
    expect(() => calculatePriorityScore(score)).not.toThrow()
    expect(calculatePriorityScore(score)).toBeCloseTo(0.9)
  })
})

describe('SCORABLE_TYPE_META display labels', () => {
  // Bound to feedbackForms ON PURPOSE, not to prioritization: these keys are read
  // from two namespaces — the badge in PRFAQRow (prioritization) and the document
  // select in FeedbackForms/ValidationLinkPicker (feedbackForms) — and only the
  // foreign binding can fail. A relative key resolves fine in its own namespace,
  // so a test using `prioritization` passes with or without the prefix and proves
  // nothing. This is the gate the badge itself never had: no Prioritization test
  // asserts the badge text, so un-qualifying these keys left that suite green.
  const t = i18n.getFixedT(null, 'feedbackForms')

  it("keep working only while the app's nsSeparator is ':' — assert the real config", () => {
    // The resolution test below runs against the TEST i18n instance (src/test/setup.ts),
    // so it would stay green if the APP disabled the namespace separator — a common
    // workaround for keys that contain colons. I18N_INIT_OPTIONS is the object
    // src/i18n/config.ts hands to init(), imported from a side-effect-free module so
    // reading it here does not start the HTTP backend.
    expect(
      I18N_INIT_OPTIONS.nsSeparator ?? ':',
      'the app disabled/changed nsSeparator — every `prioritization:docType.*` read '
      + '(the Prioritization badge, the Feedback Forms document picker) now renders '
      + 'the raw key path',
    ).toBe(':')
    // And the test instance must agree, or the assertion below tests a different
    // resolver than the app ships.
    expect(i18n.options.nsSeparator ?? ':').toBe(':')
  })

  it('resolve to real text, not the raw key path, from another namespace', () => {
    const entries = Object.entries(SCORABLE_TYPE_META)
    expect(entries.length, 'nothing is scorable — the constant is empty').toBeGreaterThan(0)

    for (const [type, meta] of entries) {
      if (!meta) throw new Error(`${type} has no display metadata`)
      const label = t(meta.i18nKey)
      expect(label, `${type}: '${meta.i18nKey}' does not resolve — the badge and the
        document picker would both render this raw key path to users`)
        .not.toBe(meta.i18nKey)
      expect(label.trim(), `${type} resolves to an empty label`).not.toBe('')
    }
  })

  it('name the scorable types PRD and PR/FAQ', () => {
    // Pinned literals, not the catalogue value looked up the same way the code
    // does: this is what a user reads on the Prioritization badge and in the
    // document select, and it is the assertion that fails if a rename lands in
    // one place only.
    const { prd, prfaq } = SCORABLE_TYPE_META
    if (!prd || !prfaq) throw new Error('prd/prfaq are no longer scorable — update this test')

    expect(t(prd.i18nKey)).toBe('PRD')
    expect(t(prfaq.i18nKey)).toBe('PR/FAQ')
  })
})

describe('overLongNoteDocuments', () => {
  // The API refuses a note past MAX_NOTE_LENGTH rather than truncating it, and
  // `fetchApi` discards the response body, so the page has to spot the refusal
  // before sending or Save appears to do nothing.
  // No cast: the helper is typed for the shape it reads, so a record whose note
  // is absent — which stored ballots really are — is expressible here.
  const score = (notes?: string | null): { readonly notes?: string | null } => ({ notes })

  it('names the document whose note is over the bound', () => {
    const edits = { d1: score('x'.repeat(MAX_NOTE_LENGTH + 1)) }

    expect(overLongNoteDocuments(edits)).toEqual(['d1'])
  })

  it('accepts a note exactly at the bound', () => {
    // The backend's check is `> MAX`, so the boundary value is legal. An
    // off-by-one here would block a save the API would have accepted.
    const edits = { d1: score('x'.repeat(MAX_NOTE_LENGTH)) }

    expect(overLongNoteDocuments(edits)).toEqual([])
  })

  it('names every offending document, not just the first', () => {
    const edits = {
      d1: score('x'.repeat(MAX_NOTE_LENGTH + 1)),
      d2: score('short'),
      d3: score('y'.repeat(MAX_NOTE_LENGTH + 500)),
    }

    expect(overLongNoteDocuments(edits).sort()).toEqual(['d1', 'd3'])
  })

  it('treats a missing note as no note rather than crashing', () => {
    // Stored ballots predate `notes` being written on every save, and this record
    // arrives from the network with no runtime guarantee it matches the type. A
    // throw here would take down the page on a save the API would have accepted.
    expect(overLongNoteDocuments({ d1: score(undefined) })).toEqual([])
    expect(overLongNoteDocuments({ d1: score(null) })).toEqual([])
  })

  it('is empty when nothing is pending', () => {
    expect(overLongNoteDocuments({})).toEqual([])
  })
})

describe('overLongNoteDocuments counts in the unit the API uses', () => {
  // JS `.length` is UTF-16 code units; the API's `len()` is code points. Pinning
  // the unit, not just the number: a lockstep on the two constants would pass while
  // the page measured a different thing with them.
  //
  // Astral characters are the ONLY inputs that discriminate — they are the only ones
  // whose two counts differ — so these two cases are the whole of the unit coverage
  // and both are needed: the first fails under a code-unit count, the second fails if
  // counting code points ever became "emoji are free". A combining sequence measures
  // the same either way and would pass whichever count was used, which is why there
  // is no third case here.
  const score = (notes: string): { readonly notes: string } => ({ notes })

  it('accepts a note of astral characters the API would accept', () => {
    // 1500 emoji: 3000 code units, 1500 code points. A code-unit count blocks this
    // and quotes a limit the reviewer never reached.
    const emoji = '😀'.repeat(MAX_NOTE_LENGTH - 500)

    expect(overLongNoteDocuments({ d1: score(emoji) })).toEqual([])
  })

  it('still refuses astral characters past the bound', () => {
    // The positive control for the test above: counting code points must not become
    // "emoji are free".
    const emoji = '😀'.repeat(MAX_NOTE_LENGTH + 1)

    expect(overLongNoteDocuments({ d1: score(emoji) })).toEqual(['d1'])
  })
})
