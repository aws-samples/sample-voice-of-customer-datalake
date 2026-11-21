/** The Report's reads and its AI summary (7.63.00): the shapes read leniently, the requests' addresses, and what a
 * summary sends (free-text answers only, never a contact detail, within the route's limits). */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { feedbackFormsV2Api, isSummaryOfView, summaryFilters } from './feedbackFormsV2Api'
import type { ResultsFilters } from './feedbackFormsV2Api'
import { SUMMARY_LIMITS, parseFormComparison, parseFormReport, summaryAnswers } from './feedbackFormsReport'
import { parseResponsesPage } from './feedbackFormsV2Results'
import { sampleForm } from '../pages/FeedbackForms/test/draftHarness'

vi.mock('./baseUrl', async (importOriginal) => ({ ...await importOriginal<typeof import('./baseUrl')>(), getBaseUrl: () => 'https://api.example.com' }))

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
const FILTERS: ResultsFilters = { days: null, language: 'en', ending: '', hidden: { customer: 'Example Ltd' }, includeTest: false }

describe('the report shapes', () => {
  it('read a report leniently: a malformed part costs only itself', () => {
    const report = parseFormReport({
      name: 'Workshop', responses: 9, kpis: [{ id: 'q_nps', type: 'nps', answered: 9, average: 8, nps: { score: 33.3, promoters: 4, passives: 4, detractors: 1 } }, { bad: true }],
      segments: { by: 'hidden.customer', min_size: 5, groups: [{ value: 'Example Ltd', responses: 7, scores: { q_nps: { type: 'nps', answered: 7, nps: 40 } } }],
        merged: { segments: 1, responses: 2, scores: null } },
      themes: 'oops', ai: { report_id: 'rpt_1', withheld: 'access' },
    })
    expect(report.kpis.map((kpi) => kpi.id)).toStrictEqual(['q_nps'])
    expect([report.segments?.groups[0]?.scores?.['q_nps']?.nps, report.segments?.merged?.scores]).toStrictEqual([40, null])
    expect([report.themes, report.ai?.withheld, report.min_segment]).toStrictEqual([[], 'access', 5])
    expect(parseFormReport(null).ai).toBeNull()
  })

  it('read a comparison, each form saying which questions it asks otherwise', () => {
    const comparison = parseFormComparison({ by: null, questions: [{ id: 'q_value', type: 'rating', headline: 'Value' }],
      forms: [{ form_id: 'f_b', name: 'B', unmatched: { q_value: 'different', q_x: 'nonsense' } }],
      points: [{ form_id: 'f_b', value: null, responses: 3, scores: null }] })
    expect(comparison.forms[0]?.unmatched).toStrictEqual({})
    expect(comparison.points[0]?.scores).toBeNull()
  })
})

describe('what a summary reads', () => {
  const form = sampleForm({ questions: [
    { id: 'q_takeaway', type: 'open_text', headline: { en: 'Takeaway' }, required: false, long: true, input_type: 'text' },
    { id: 'q_email', type: 'open_text', headline: { en: 'Email' }, required: false, long: false, input_type: 'email' },
    { id: 'q_improve', type: 'open_text', headline: { en: 'Improve' }, required: false, long: false, input_type: 'text' },
  ] })
  const page = (answers: readonly Record<string, unknown>[]) => parseResponsesPage({
    responses: answers.map((value, index) => ({ response_id: `fb_${String(index)}`, submitted_at: '2026-11-01', answers: value })),
  }).responses

  it('joins each response’s free-text answers, never an email or a contact answer, and skips one with none', () => {
    expect(summaryAnswers(form, page([
      { q_takeaway: 'Labs', q_email: 'a@example.com', q_improve: 'More time' }, { q_email: 'b@example.com' }, { q_improve: 'Shorter' },
    ]))).toStrictEqual([{ response_id: 'fb_0', text: 'Labs\nMore time' }, { response_id: 'fb_2', text: 'Shorter' }])
  })

  it('stops at the route’s limits', () => {
    const many = page(Array.from({ length: 400 }, () => ({ q_takeaway: 'x'.repeat(150) })))
    const sent = summaryAnswers(form, many)
    expect(sent.length).toBeLessThanOrEqual(SUMMARY_LIMITS.answers)
    expect(sent.reduce((sum, answer) => sum + answer.text.length, 0)).toBeLessThanOrEqual(SUMMARY_LIMITS.chars)
  })

  it('records the view’s filters by their query names, and its range', () => {
    expect(summaryFilters(FILTERS)).toStrictEqual({ language: 'en', 'hidden.customer': 'Example Ltd', days: 'all' })
    const lastMonth = summaryFilters({ ...FILTERS, days: 30 })
    expect([lastMonth['days'], typeof lastMonth['from']]).toStrictEqual(['30', 'string'])
  })

  it('knows a summary of this view by its range, language, ending and hidden values, never by its from', () => {
    const stored = { from: '2026-10-01T00:00:00.000Z', days: '30', language: 'en', 'hidden.customer': 'Example Ltd' }
    expect(isSummaryOfView(stored, { ...FILTERS, days: 30 })).toBe(true)
    expect(isSummaryOfView(stored, { ...FILTERS, days: 30, hidden: { customer: 'Sample Co' } })).toBe(false)
    expect(isSummaryOfView(stored, { ...FILTERS, days: 30, hidden: {} })).toBe(false)
    expect(isSummaryOfView(stored, FILTERS)).toBe(false)
  })
})

describe('the report requests', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ask for the report under the filters and a segment, and for a comparison', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(200, { success: true, responses: 0 })))
    await feedbackFormsV2Api.getReport('f 1', FILTERS, 'q_phases.labs')
    await feedbackFormsV2Api.compareForms('f_1', FILTERS, ['f_2', 'f_3'], 'hidden.event_date')
    const [report, compare] = fetchMock.mock.calls.map(([url]) => new URL(url))
    expect(report?.pathname).toBe('/feedback-forms/f%201/report')
    expect(report?.searchParams.get('group_by')).toBe('q_phases.labs')
    expect(report?.searchParams.get('hidden.customer')).toBe('Example Ltd')
    expect([compare?.searchParams.get('with'), compare?.searchParams.get('by')]).toStrictEqual(['f_2,f_3', 'hidden.event_date'])
  })

  it('starts a summary job with what was read and polls it to the stored report’s id', async () => {
    fetchMock.mockResolvedValueOnce(json(202, { success: true, job_id: 'job_1' }))
      .mockResolvedValueOnce(json(200, { status: 'completed', result: { success: true, form_id: 'f_1', report_id: 'rpt_9' } }))
    const id = await feedbackFormsV2Api.summarizeReport('f_1', { answers: [{ response_id: 'fb_1', text: 'Labs' }],
      filters: { language: 'en' }, lastResponseAt: '2026-11-12T10:00:00Z' })
    expect(id).toBe('rpt_9')
    const sent = fetchMock.mock.calls[0]?.[1]?.body
    const body: unknown = typeof sent === 'string' ? JSON.parse(sent) : null
    // (how many it read is the answers' count, recorded by the server: no count of the view is sent)
    expect(body).toStrictEqual({ form_id: 'f_1', answers: [{ response_id: 'fb_1', text: 'Labs' }], filters: { language: 'en' },
      last_response_at: '2026-11-12T10:00:00Z' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.example.com/settings/form-reports/job_1')
  })

  it('words a summary that found nothing as a 422', async () => {
    fetchMock.mockResolvedValueOnce(json(202, { success: true, job_id: 'job_1' }))
      .mockResolvedValueOnce(json(200, { status: 'completed', result: { success: false, code: 'no_summary', error: 'none' } }))
    const error: unknown = await feedbackFormsV2Api.summarizeReport('f_1', { answers: [], filters: {}, lastResponseAt: null })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ status: 422, code: 'no_summary' })
  })
})
