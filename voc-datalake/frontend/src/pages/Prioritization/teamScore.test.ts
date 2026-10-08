/**
 * @fileoverview Tests for teamScore — what one row may say about the team.
 */
import { describe, it, expect } from 'vitest'
import i18n from 'i18next'
import { getScore, calculatePriorityScore, DEFAULT_SCORE } from './prioritizationUtils'
import { getTeamScore, getPriorityLabel, priorityBand, reviewersDisagreed, getTeamView, teamScoreOf } from './teamScore'
import type { PrioritizationAggregate } from '../../api/projectTypes'
import { aggregate } from './prioritization-unit-fixtures'

/** The team score of one document whose aggregate row reads `fields`. */
const teamScoreFromAggregate = (fields: Partial<PrioritizationAggregate> & { reviewer_count: number }) =>
  getTeamScore({ d1: aggregate(fields) }, 'd1')

describe('getTeamScore', () => {
  // The #343 arithmetic: the composite covers what the team EXPRESSED, weights
  // renormalised to the expressed axes, and an axis the backend reported as 0.0
  // (its contract for "nobody scored this") is null — a dash, not a number.

  it('renormalises a one-axis ballot to that axis rather than averaging in zeros', () => {
    // Impact 4 alone. Weighing the three unexpressed axes as 0 composited this
    // to 1.6 and banded it Low Priority — three zeros nobody entered outvoting
    // the one number somebody did, which is the production defect (#343).
    const team = teamScoreFromAggregate({ impact: 4, time_to_market: 0, strategic_fit: 0, confidence: 0, reviewer_count: 1 })

    expect(team?.displayComposite).toBe(4.0)
    expect(team?.displayImpact).toBe(4.0)
    expect(team?.reviewerCount).toBe(1)
  })

  it('reports an axis nobody scored as null, never as a number', () => {
    const team = teamScoreFromAggregate({ impact: 4, time_to_market: 0, strategic_fit: 0, confidence: 0, reviewer_count: 1 })

    // 0.0 TTM on a ballot that never mentioned time to market was the chip
    // that made the row read as rated-worst on an axis nobody rated.
    expect(team?.displayTimeToMarket).toBeNull()
  })

  it('renormalises two expressed axes over their own weights', () => {
    // impact 4 (weight .4) + confidence 2 (weight .1): (1.6 + 0.2) / 0.5 = 3.6.
    const team = teamScoreFromAggregate({ impact: 4, time_to_market: 0, strategic_fit: 0, confidence: 2, reviewer_count: 2 })

    expect(team?.displayComposite).toBe(3.6)
  })

  it('a ballot that expressed no axis at all has no composite', () => {
    // A notes-only ballot: the aggregate row exists (reviewer_count 1) and no
    // axis was scored. There is no number to print, and inventing one is the
    // defect this replaces. The band reads 'none' off the same null.
    const team = teamScoreFromAggregate({ impact: 0, time_to_market: 0, strategic_fit: 0, confidence: 0, reviewer_count: 1 })

    expect(team?.displayComposite).toBeNull()
    expect(team?.displayImpact).toBeNull()
    expect(team?.displayTimeToMarket).toBeNull()
    expect(team?.reviewerCount).toBe(1)
  })

  it('a fully-expressed aggregate composites exactly as before', () => {
    // The regression guard for the renormalisation: when every axis is
    // expressed, the expressed weights sum to 1 and dividing by them changes
    // nothing — a full ballot's number is untouched by #343.
    const team = teamScoreFromAggregate({ impact: 5, time_to_market: 4, strategic_fit: 2, confidence: 3, reviewer_count: 4 })

    expect(team?.displayComposite).toBe(3.9)
  })

  it('composites the team means through the same weights the page sorts by', () => {
    // 5*0.4 + 4*0.3 + 2*0.2 + 3*0.1 = 3.9 — the calculatePriorityScore case above,
    // reached through the aggregate. The displayed number and the sort order are
    // then the same arithmetic by construction.
    const team = teamScoreFromAggregate({ impact: 5, time_to_market: 4, strategic_fit: 2, confidence: 3, reviewer_count: 4 })

    // Read off `calculatePriorityScore` rather than a raw field on `TeamScore`, which
    // deliberately carries only the rounded value. This is the stronger form anyway: it
    // names the two functions whose agreement is the actual claim.
    expect(calculatePriorityScore(aggregate({
      impact: 5, time_to_market: 4, strategic_fit: 2, confidence: 3, reviewer_count: 4,
    }))).toBeCloseTo(3.9)
    expect(team?.displayComposite).toBe(3.9)
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
    // The same guard on the caller's own half, which lacked it: `??` does not fire on an
    // inherited value, so this answered `Object.prototype.toString` — a function where a
    // ballot is declared, with every axis `undefined`.
    expect(getScore({}, 'toString')).toStrictEqual({ ...DEFAULT_SCORE, row_id: 'toString' })
    expect(typeof getScore({}, 'toString')).toBe('object')
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
    const team = teamScoreFromAggregate({ impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 4, reviewer_count: 2 })

    // The unrounded arithmetic is below 4 while the value the page reads is 4 — the
    // whole point of rounding once. Taken from `calculatePriorityScore` because
    // `TeamScore` carries no raw copy to disagree with it.
    expect(calculatePriorityScore(aggregate({
      impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 4, reviewer_count: 2,
    }))).toBeLessThan(4)
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

  it('bands a notes-only ballot as Not Scored rather than Low', () => {
    // Somebody said something — the reviewer count is real — but nobody scored
    // an axis, so there is no composite to band. 'low' would rank a comment as
    // a verdict; before #343 the four zeros composited to 0 and did exactly
    // that.
    expect(bandOf({ ...uniform(0), reviewer_count: 1 })).toBe('none')
  })

  it('bands a one-axis ballot by that axis, not by the zeros beside it', () => {
    // The production reproduction of #343: impact 4 alone banded 'low' off a
    // 1.6 composite. Renormalised, the one expressed number is the composite.
    expect(bandOf({ impact: 4, time_to_market: 0, confidence: 0, strategic_fit: 0, reviewer_count: 1 }))
      .toBe('high')
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

    expect(getTeamScore(aggregates, 'd1')?.displayComposite?.toFixed(1)).toBe('4.0')
    expect(getPriorityLabel(getTeamView(aggregates, 'd1'), t).label).toBe('High Priority')
  })
})

describe('getTeamView tells the states of the team view apart', () => {
  // The distinction the page turns on: "the team rated this low", "nobody has voted"
  // and "we could not find out" are three different statements, and only the first
  // two are about the document.
  it('reads a document in the map as scored', () => {
    const view = getTeamView({ d1: aggregate({ impact: 5, reviewer_count: 2 }) }, 'd1')

    expect(view.kind).toBe('scored')
    expect(teamScoreOf(view)?.displayImpact).toBe(5)
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
