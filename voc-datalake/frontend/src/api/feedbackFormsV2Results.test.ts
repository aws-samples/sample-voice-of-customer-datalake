/**
 * The forms data quality additions to Results and Responses, read as this app's: a matrix question's rows (and what it no
 * longer has), the link checks, and a matrix answer; an answer from an older server, without them, reads as before.
 */
import { describe, expect, it } from 'vitest'
import { adaptResults } from './feedbackFormsResultsAdapter'
import { parseFormResults, parseResponsesPage } from './feedbackFormsV2Results'

const matrixQuestion = {
  id: 'q_phases', type: 'matrix', shown: 10, answered: 9, skipped: 1, not_shown: 0, scored: true,
  rows: [{ code: 'intro', answered: 9, counts: { poor: 2, ok: 7 }, average: 1.78 }, { code: 'lab', answered: 8, counts: { ok: 8 }, average: null }, { code: 7 }],
  removed_rows: { demo: 3 },
}
const linkHealth = {
  responses: 26, hidden: { customer: { filled: 0, missing: 26 }, broken: 'x' },
  by_channel: { link: { responses: 26, hidden: { customer: { filled: 0, missing: 26 } } } },
  warnings: [{ id: 'customer', kind: 'never_filled', filled: 0, total: 26 }, { id: 'x', kind: 'unheard_of' }],
}
const answer = { responses: 10, test_responses: 0, last_response_at: null, questions: [matrixQuestion], endings: {}, removed_questions: [], funnel: null }

describe('Results', () => {
  it("reads a matrix question's rows in order, a malformed row left out, and what it no longer has", () => {
    expect(parseFormResults(adaptResults(answer)).questions['q_phases']?.matrix).toStrictEqual({
      rows: [{ code: 'intro', answered: 9, counts: { poor: 2, ok: 7 }, average: 1.78 }, { code: 'lab', answered: 8, counts: { ok: 8 }, average: null }],
      scored: true, removed_rows: { demo: 3 }, removed_columns: {},
    })
  })

  it('reads the link checks, a malformed entry left out', () => {
    const health = parseFormResults(adaptResults({ ...answer, link_health: linkHealth })).link_health
    expect(health?.hidden).toStrictEqual({ customer: { filled: 0, missing: 26 } })
    expect(health?.warnings).toStrictEqual([{ id: 'customer', kind: 'never_filled', filled: 0, total: 26 }])
    expect(health?.by_channel['link']?.responses).toBe(26)
  })

  it('reads an older answer, with neither, as before', () => {
    const results = parseFormResults(adaptResults({ ...answer, questions: [{ id: 'q_nps', type: 'nps', answered: 1, histogram: { 9: 1 } }] }))
    expect([results.link_health, results.questions['q_nps']?.matrix]).toStrictEqual([null, undefined])
  })
})

describe('Responses', () => {
  it('keeps a matrix answer as its rows, never as an empty contact', () => {
    const page = parseResponsesPage({ responses: [{ response_id: 'r1', answers: { q_phases: { rows: { intro: 'ok', lab: 'top' } }, q_contact: { email: 'a@example.com' } } }] })
    expect(page.responses[0]?.answers).toStrictEqual({ q_phases: { rows: { intro: 'ok', lab: 'top' } }, q_contact: { email: 'a@example.com' } })
  })
})
