import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FormsApiError, feedbackFormsV2Api } from './feedbackFormsV2Api'
import { adaptResults, adaptResponsesPage } from './feedbackFormsResultsAdapter'
import { parseFormResults, parseResponsesPage } from './feedbackFormsV2Results'

vi.mock('./baseUrl', async (importOriginal) => ({ ...await importOriginal<typeof import('./baseUrl')>(), getBaseUrl: () => 'https://api.example.com' }))

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

describe('the forms builder client (reconciled with part A)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a stale save\'s stored revision on the 409', async () => {
    fetchMock.mockResolvedValue(json(409, { success: false, error: 'The form was changed by someone else', code: 'revision_conflict', revision: 7 }))
    const error: unknown = await feedbackFormsV2Api.saveForm('f_1', (await import('../pages/FeedbackForms/test/draftHarness')).sampleForm(), 6).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FormsApiError)
    expect(error instanceof FormsApiError ? [error.status, error.code, error.current?.revision] : []).toStrictEqual([409, 'revision_conflict', 7])
  })

  it('polls an AI draft job until it ends, and words a twice-refused draft as a 422 with its errors', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(json(202, { success: true, job_id: 'job_1', status: 'pending' }))
      .mockResolvedValueOnce(json(200, { success: true, status: 'running' }))
      .mockResolvedValueOnce(json(200, { success: true, status: 'completed', result: { success: false, code: 'invalid_draft', error: 'Invalid', errors: ['Question 4 has 52 options'] } }))
    const pending = feedbackFormsV2Api.draftForm({ description: 'An NPS form', language: 'en', channel: 'link' }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(4000)
    const error = await pending
    vi.useRealTimers()
    expect(error instanceof FormsApiError ? [error.status, error.code, error.errors.map((e) => e.message)] : []).toStrictEqual([422, 'invalid_draft', ['Question 4 has 52 options']])
    expect(fetchMock.mock.calls.map(([url]) => url)).toStrictEqual([
      'https://api.example.com/settings/form-drafts', 'https://api.example.com/settings/form-drafts/job_1', 'https://api.example.com/settings/form-drafts/job_1',
    ])
  })

  it('polls no more once the draft is stopped, and drops what it would have answered', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(json(202, { success: true, job_id: 'job_1', status: 'pending' }))
      .mockResolvedValue(json(200, { success: true, status: 'running' }))
    const stop = new AbortController()
    const pending = feedbackFormsV2Api.draftForm({ description: 'An NPS form', language: 'en', channel: 'link' }, stop.signal)
      .catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1600)
    const polled = fetchMock.mock.calls.length
    stop.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    const error = await pending
    vi.useRealTimers()
    expect(polled).toBe(2)
    expect(fetchMock.mock.calls).toHaveLength(polled)
    expect(error instanceof DOMException ? error.name : error).toBe('AbortError')
  })

  it('says whether the person may delete the test responses, and lets the creator of a new form', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { success: true, form: await record({ response_count: 0, can_delete_test_responses: false }) }))
    expect((await feedbackFormsV2Api.getForm('f_1')).meta.can_delete_test_responses).toBe(false)
    const { sampleForm } = await import('../pages/FeedbackForms/test/draftHarness')
    fetchMock.mockResolvedValueOnce(json(200, { success: true, form: await record({}) }))
    expect((await feedbackFormsV2Api.createForm(sampleForm())).meta.can_delete_test_responses).toBe(true)
  })

  it('reads the test token from …/test-link, the only answer that carries it', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, test: { link_enabled: true, record: 'tag', token: 'tk_abc' }, test_link: 'x' }))
    expect(await feedbackFormsV2Api.rotateTestToken('f_1')).toBe('tk_abc')
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/feedback-forms/f_1/test-link', expect.objectContaining({ method: 'POST', body: '{"rotate":true}' }))
  })

  /** A stored form as part A's `GET /feedback-forms/{id}` answers it (`settings.test` never carries the token). */
  const record = async (extra: Record<string, unknown>) => {
    const { sampleForm } = await import('../pages/FeedbackForms/test/draftHarness')
    return { ...sampleForm(), form_id: 'f_1', revision: 3, updated_by: 'ana', has_responses: false,
      settings: { test: { link_enabled: true, record: 'tag', token_issued: true } }, ...extra }
  }

  it('reads one form with the count its read carries, and asks no stats for it', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, form: await record({ response_count: 12, has_responses: true }) }))
    const loaded = await feedbackFormsV2Api.getForm('f_1')
    expect(loaded.meta).toMatchObject({ revision: 3, response_count: 12, has_responses: true })
    expect(fetchMock.mock.calls.map(([url]) => url)).toStrictEqual(['https://api.example.com/feedback-forms/f_1'])
  })

  it('asks the stats for the count only when the read could not count (stats_error)', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { success: true, form: await record({}), stats_error: 'Failed to count the form\'s responses' }))
      .mockResolvedValueOnce(json(200, { success: true, stats: { total_submissions: 4 } }))
    const loaded = await feedbackFormsV2Api.getForm('f_1')
    expect(loaded.meta).toMatchObject({ response_count: 4, has_responses: true })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.example.com/feedback-forms/f_1/stats')
  })

  it('never reads a test token from a form record', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, form: await record({ response_count: 0, test_token: 'tk_leaked' }) }))
    const loaded = await feedbackFormsV2Api.getForm('f_1')
    expect(JSON.stringify(loaded)).not.toContain('tk_leaked')
  })

  it('asks the Test tab\'s list with include_test=only', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, responses: [], next_cursor: null }))
    await feedbackFormsV2Api.getResponses('f_1', { days: null, language: '', ending: '', hidden: {}, includeTest: true }, { limit: 20, testOnly: true })
    expect(fetchMock.mock.calls[0]?.[0]).toContain('include_test=only')
  })

  it('names what a save removes from an answered form, and sends no `removes` when it names nothing (D9)', async () => {
    const { sampleForm } = await import('../pages/FeedbackForms/test/draftHarness')
    fetchMock.mockImplementation(async () => json(200, { success: true, form: await record({ response_count: 0 }) }))
    await feedbackFormsV2Api.saveForm('f_1', sampleForm(), 3, { questions: ['q_old'], options: { q_reason: ['bugs'] } })
    await feedbackFormsV2Api.saveForm('f_1', sampleForm(), 4)
    const bodies = fetchMock.mock.calls.map(([, init]): object => {
      const parsed: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    })
    const field = (body: object, key: string): unknown => Reflect.get(body, key)
    expect(bodies.map((body) => [field(body, 'expected_revision'), field(body, 'removes')])).toStrictEqual([
      [3, { questions: ['q_old'], options: { q_reason: ['bugs'] } }], [4, undefined],
    ])
    expect(Object.keys(bodies[1] ?? {})).not.toContain('removes')
  })

  it('keeps the lock\'s refusal (409 answers_locked) apart from a stale save by its code', async () => {
    const { sampleForm } = await import('../pages/FeedbackForms/test/draftHarness')
    fetchMock.mockResolvedValue(json(409, { success: false, error: 'This form has responses', code: 'answers_locked', questions: ['q_old'], options: {} }))
    const error = await feedbackFormsV2Api.saveForm('f_1', sampleForm(), 3).catch((e: unknown) => e)
    expect(error instanceof FormsApiError ? [error.status, error.code, error.message] : []).toStrictEqual([409, 'answers_locked', 'This form has responses'])
  })
})

describe('part A\'s results and responses, read as this app\'s', () => {
  const answer = {
    responses: 10, test_responses: 2, last_response_at: '2026-11-17T10:00:00Z',
    questions: [
      { id: 'q_reason', type: 'single_select', shown: 10, answered: 9, skipped: 1, not_shown: 0, options: { price: 6, bugs: 3 }, other: 1,
        other_latest: [{ value: 'drukowanie', response_id: 'r1', created_at: '2026-11-17T09:00:00Z', is_test: false }] },
      { id: 'q_nps', type: 'nps', shown: 8, answered: 8, skipped: 0, not_shown: 2, histogram: { 0: 1, 9: 4, 10: 3 }, average: 7.9, scale_max: 10 },
      { id: 'q_text', type: 'open_text', shown: 4, answered: 3, skipped: 1, not_shown: 6, count: 3,
        latest: [{ value: 'Faster please', response_id: 'fb_1', created_at: '2026-11-17T08:00:00Z', is_test: false, sentiment: 'negative' }] },
      { id: 'q_contact', type: 'contact_info', shown: 3, answered: 2, skipped: 1, not_shown: 7, contacts: 2 },
    ],
    endings: { end_thanks: 10 }, removed_questions: [{ id: 'q_old', answered: 4 }],
    funnel: { opened: 20, left: { q_reason: 3, q_nps: 2 }, completed: 10 },
  }

  it('folds Other into the option counts and keeps its typed answers', () => {
    const question = parseFormResults(adaptResults(answer)).questions['q_reason']
    expect(question?.counts).toStrictEqual({ price: 6, bugs: 3, other: 1 })
    expect(question?.other_answers).toStrictEqual(['drukowanie'])
  })

  it('reads a histogram as the distribution, and the latest open answers with their feedback items', () => {
    const results = parseFormResults(adaptResults(answer))
    expect(results.questions['q_nps']?.distribution).toStrictEqual({ 0: 1, 9: 4, 10: 3 })
    expect(results.questions['q_text']?.latest?.[0]).toStrictEqual(expect.objectContaining({ text: 'Faster please', feedback_id: 'fb_1', sentiment: 'negative' }))
    expect(results.questions['q_contact']?.contact).toStrictEqual({ left: 2, emails: null, phones: null })
    expect([results.total, results.test_count]).toStrictEqual([10, 2])
  })

  it('turns where people left into the funnel\'s steps (reached = completed + those who left there or later)', () => {
    expect(parseFormResults(adaptResults(answer)).funnel).toStrictEqual({
      opened: 20, started: 15, completed: 10,
      steps: [{ question_id: 'q_reason', reached: 15 }, { question_id: 'q_nps', reached: 12 }, { question_id: 'q_text', reached: 10 }, { question_id: 'q_contact', reached: 10 }],
    })
  })

  it('has no funnel when the beacon counted no open, or fewer opens than the responses it covers', () => {
    expect(parseFormResults(adaptResults({ ...answer, funnel: { opened: 0, left: {}, completed: 10 } })).funnel).toBeNull()
    expect(parseFormResults(adaptResults({ ...answer, funnel: { opened: 4, left: {}, completed: 10 } })).funnel).toBeNull()
  })

  it('reads a response row\'s created_at and revision as its time and form revision', () => {
    const page = parseResponsesPage(adaptResponsesPage({ responses: [{ response_id: 'r1', created_at: '2026-11-17T10:00:00Z', revision: 4, language: 'pl', answers: { q_reason: { code: 'price' } }, hidden: {}, ending_id: 'end_thanks', is_test: false }], next_cursor: '50' }))
    expect(page.responses[0]).toStrictEqual(expect.objectContaining({ submitted_at: '2026-11-17T10:00:00Z', form_revision: 4 }))
    expect(page.next_cursor).toBe('50')
  })
})
