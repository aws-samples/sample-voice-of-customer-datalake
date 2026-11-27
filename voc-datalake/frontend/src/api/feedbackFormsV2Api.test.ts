import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FormsApiError, feedbackFormsV2Api } from './feedbackFormsV2Api'
import { adaptResults, adaptResponsesPage } from './feedbackFormsResultsAdapter'
import { parseFormResults, parseResponsesPage } from './feedbackFormsV2Results'
import type { ResultsFilters } from './feedbackFormsV2Api'
import { AuthError } from '../lib/errors'
import { sampleForm } from '../pages/FeedbackForms/test/draftHarness'

vi.mock('./baseUrl', async (importOriginal) => ({ ...await importOriginal<typeof import('./baseUrl')>(), getBaseUrl: () => 'https://api.example.com' }))

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
const NO_FILTERS: ResultsFilters = { days: null, language: '', ending: '', hidden: {}, includeTest: false }

/** The JSON body of the first request. */
function sentBody(): unknown {
  const body = fetchMock.mock.calls[0]?.[1]?.body
  return typeof body === 'string' ? JSON.parse(body) : null
}

describe('the forms builder client (reconciled with part A)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
      'https://api.example.com/feedback-forms/draft', 'https://api.example.com/feedback-forms/draft/job_1', 'https://api.example.com/feedback-forms/draft/job_1',
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

  it('reads the test token from …/test-link, the only answer that carries it; a reset sends the saved settings back', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, test: { link_enabled: true, record: 'tag', token: 'tk_abc' }, test_link: 'x' }))
    expect(await feedbackFormsV2Api.rotateTestToken('f_1', { link_enabled: false, record: 'drop' })).toBe('tk_abc')
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/feedback-forms/f_1/test-link',
      expect.objectContaining({ method: 'POST', body: '{"rotate":true,"link_enabled":false,"record":"drop"}' }))
  })

  it('reads the save count and the retired question ids with the form, and words a reused id with its question', async () => {
    const { sampleForm } = await import('../pages/FeedbackForms/test/draftHarness')
    fetchMock.mockResolvedValueOnce(json(200, { success: true, form: await record({ response_count: 0, write_count: 7, retired_ids: ['q_old', 3] }) }))
    expect((await feedbackFormsV2Api.getForm('f_1')).meta).toMatchObject({ write_count: 7, retired_ids: [] })
    fetchMock.mockResolvedValueOnce(json(200, { success: true, form: await record({ response_count: 0, write_count: 7, retired_ids: ['q_old'] }) }))
    expect((await feedbackFormsV2Api.getForm('f_1')).meta).toMatchObject({ write_count: 7, retired_ids: ['q_old'] })
    fetchMock.mockResolvedValueOnce(json(400, { success: false, error: 'questions: the id "q_old" belonged to a removed question', code: 'question_id_reused', question_id: 'q_old' }))
    const error = await feedbackFormsV2Api.saveForm('f_1', sampleForm(), 3).catch((e: unknown) => e)
    expect(error instanceof FormsApiError ? [error.code, error.questionId] : []).toStrictEqual(['question_id_reused', 'q_old'])
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

  describe('a refusal', () => {
    it('keeps a 400\'s field errors, with the question each names, and drops what is not one', async () => {
      fetchMock.mockResolvedValue(json(400, { error: 'Invalid form', errors: [{ message: 'Question 4 has 52 options', question_id: 'q_reason' }, 'Add an ending', 42] }))
      const error = await feedbackFormsV2Api.saveForm('f_1', sampleForm(), 3).catch((e: unknown) => e)
      expect(error instanceof FormsApiError ? [error.status, error.message, error.errors] : []).toStrictEqual([
        400, 'Invalid form', [{ message: 'Question 4 has 52 options', questionId: 'q_reason' }, { message: 'Add an ending' }],
      ])
    })

    it('without a JSON body is still a FormsApiError of its status', async () => {
      fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }))
      const error = await feedbackFormsV2Api.getResults('f_1', NO_FILTERS).catch((e: unknown) => e)
      expect(error instanceof FormsApiError ? [error.status, error.message, error.errors, error.current] : []).toStrictEqual([502, 'API Error: 502', [], null])
    })

    it('reads a 429\'s wait from the Retry-After header when the body has none', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'rate_limited' }), { status: 429, headers: { 'Retry-After': '30' } }))
      const error = await feedbackFormsV2Api.draftForm({ description: 'An NPS form', language: 'en', channel: 'link' }).catch((e: unknown) => e)
      expect(error instanceof FormsApiError ? [error.code, error.retryAfterSeconds] : []).toStrictEqual(['rate_limited', 30])
    })

    it('rejects an answer that carries no form', async () => {
      fetchMock.mockResolvedValue(json(200, { success: true }))
      await expect(feedbackFormsV2Api.createForm(sampleForm())).rejects.toThrow('The server answered without a form.')
    })
  })

  describe('the writes', () => {
    it('creates a form Off, whatever the draft says, and reads the stored copy back', async () => {
      fetchMock.mockResolvedValue(json(201, { success: true, form: await record({ response_count: 0, enabled: false }) }))
      const loaded = await feedbackFormsV2Api.createForm(sampleForm({ enabled: true }))
      expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/feedback-forms', expect.objectContaining({ method: 'POST' }))
      expect(sentBody()).toMatchObject({ name: 'Sample form', enabled: false })
      expect([loaded.meta.form_id, loaded.form.name]).toStrictEqual(['f_1', 'Sample form'])
    })

    it('turns a form on or off, over its revision when it has one', async () => {
      fetchMock.mockImplementation(async () => json(200, { success: true, form: await record({ response_count: 0 }) }))
      await feedbackFormsV2Api.setEnabled('f_1', false, 3)
      await feedbackFormsV2Api.setEnabled('f_1', true)
      await feedbackFormsV2Api.setEnabled('f_1', false, 3, 9)
      expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toStrictEqual([
        ['https://api.example.com/feedback-forms/f_1', 'PUT', '{"enabled":false,"expected_revision":3}'],
        ['https://api.example.com/feedback-forms/f_1', 'PUT', '{"enabled":true}'],
        ['https://api.example.com/feedback-forms/f_1', 'PUT', '{"enabled":false,"expected_revision":3,"expected_write_count":9}'],
      ])
    })

    it('names what a save removes from an answered form, and sends no `removes` when it names nothing (D9)', async () => {
      fetchMock.mockImplementation(async () => json(200, { success: true, form: await record({ response_count: 0 }) }))
      await feedbackFormsV2Api.saveForm('f_1', sampleForm(), 3, { questions: ['q_old'], options: { q_reason: ['bugs'] } }, 8)
      await feedbackFormsV2Api.saveForm('f_1', sampleForm(), 4)
      const bodies = fetchMock.mock.calls.map(([, init]): object => {
        const parsed: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
        return typeof parsed === 'object' && parsed !== null ? parsed : {}
      })
      const field = (body: object, key: string): unknown => Reflect.get(body, key)
      expect(bodies.map((body) => [field(body, 'expected_revision'), field(body, 'removes'), field(body, 'expected_write_count')]))
        .toStrictEqual([[3, { questions: ['q_old'], options: { q_reason: ['bugs'] } }, 8], [4, undefined, undefined]])
      expect(Object.keys(bodies[1] ?? {})).not.toContain('removes')
    })

    it('keeps the lock\'s refusal (409 answers_locked) apart from a stale save by its code', async () => {
      fetchMock.mockResolvedValue(json(409, { success: false, error: 'This form has responses', code: 'answers_locked', questions: ['q_old'], options: {} }))
      const error = await feedbackFormsV2Api.saveForm('f_1', sampleForm(), 3).catch((e: unknown) => e)
      expect(error instanceof FormsApiError ? [error.status, error.code, error.message] : []).toStrictEqual([409, 'answers_locked', 'This form has responses'])
    })

    it('sets the test link and answers its state, token included', async () => {
      fetchMock.mockResolvedValue(json(200, { success: true, test: { token: 'tk_abc', link_enabled: false, record: 'drop' } }))
      expect(await feedbackFormsV2Api.issueTestLink('f_1', { link_enabled: false, record: 'drop' })).toStrictEqual({ token: 'tk_abc', link_enabled: false, record: 'drop' })
      expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/feedback-forms/f_1/test-link', expect.objectContaining({ method: 'POST', body: '{"link_enabled":false,"record":"drop"}' }))
    })

    it('deletes the test responses and says how many went', async () => {
      fetchMock.mockResolvedValue(json(200, { success: true, deleted: 4 }))
      expect(await feedbackFormsV2Api.deleteTestResponses('f_1')).toBe(4)
      expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/feedback-forms/f_1/responses?test=true', expect.objectContaining({ method: 'DELETE' }))
    })
  })

  describe('reading a stored form', () => {
    it('finds the form in the list when the server has no route for one form', async () => {
      fetchMock
        .mockResolvedValueOnce(json(404, { error: 'Not found' }))
        .mockResolvedValueOnce(json(200, { forms: [{ form_id: 'f_2' }, await record({ response_count: 2 })] }))
      const loaded = await feedbackFormsV2Api.getForm('f_1')
      expect([loaded.meta.form_id, loaded.meta.response_count]).toStrictEqual(['f_1', 2])
      expect(fetchMock.mock.calls.map(([url]) => url)).toStrictEqual(['https://api.example.com/feedback-forms/f_1', 'https://api.example.com/feedback-forms'])
    })

    it('is a 404 when the list does not have it either', async () => {
      fetchMock
        .mockResolvedValueOnce(json(405, { error: 'Method not allowed' }))
        .mockResolvedValueOnce(json(200, { forms: [{ form_id: 'f_2' }] }))
      const error = await feedbackFormsV2Api.getForm('f_1').catch((e: unknown) => e)
      expect(error instanceof FormsApiError ? [error.status, error.code] : []).toStrictEqual([404, 'not_found'])
    })

    it('counts no responses when the stats cannot be read either', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      fetchMock
        .mockResolvedValueOnce(json(200, { success: true, form: await record({}), stats_error: 'Failed to count' }))
        .mockResolvedValueOnce(json(500, { error: 'Stats are down' }))
      const loaded = await feedbackFormsV2Api.getForm('f_1')
      expect(loaded.meta).toMatchObject({ response_count: 0, has_responses: false })
      expect(warn).toHaveBeenCalledWith('The form\'s response count could not be read:', expect.any(FormsApiError))
    })

    it('migrates a version 1 record as the server would, in the app\'s language when it had none', async () => {
      fetchMock.mockResolvedValue(json(200, { success: true, form: {
        form_id: 'f_old', schema_version: 1, name: 'Old form', rating_enabled: true, question: 'How was it?', language: '', response_count: 0,
      } }))
      const loaded = await feedbackFormsV2Api.getForm('f_old')
      expect(loaded.meta).toMatchObject({ migrated_from_v1: true, language_unconfirmed: true })
      expect([loaded.form.language, loaded.form.questions.map((q) => q.headline)]).toStrictEqual(['en', [{ en: 'How was it?' }, { en: 'Tell us more' }]])
    })
  })

  describe('results and AI drafts', () => {
    it('asks the results with the Results filters', async () => {
      vi.useFakeTimers({ now: new Date('2026-11-18T12:00:00Z'), toFake: ['Date'] })
      fetchMock.mockResolvedValue(json(200, { responses: 3, test_responses: 0, questions: [] }))
      const results = await feedbackFormsV2Api.getResults('f_1', { days: 7, language: 'pl', ending: 'end_thanks', hidden: { plan: 'pro' }, includeTest: false })
      vi.useRealTimers()
      expect(results.total).toBe(3)
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/feedback-forms/f_1/results?from=2026-11-11T12%3A00%3A00.000Z&language=pl&ending=end_thanks&hidden.plan=pro&include_test=false')
    })

    it('reads a draft answered at once, Off, with its notes and warnings', async () => {
      fetchMock.mockResolvedValue(json(200, {
        form: { ...sampleForm(), enabled: true }, notes: ['Kept it short.', { message: 'Asked for the plan.', target: 'q_feedback' }, 7],
        warnings: [{ message: 'No ending button.' }],
      }))
      const draft = await feedbackFormsV2Api.draftForm({ description: 'A short form', language: 'en', channel: 'link', base_form: sampleForm(), instruction: 'Shorter' })
      expect([draft.form.enabled, draft.notes, draft.warnings]).toStrictEqual([
        false, [{ message: 'Kept it short.' }, { message: 'Asked for the plan.', target: 'q_feedback' }], [{ message: 'No ending button.' }],
      ])
      expect(sentBody()).toMatchObject({ description: 'A short form', instruction: 'Shorter', base_form: { name: 'Sample form' } })
    })

    it('rejects a draft that came back without a form', async () => {
      fetchMock.mockResolvedValue(json(200, { notes: [] }))
      await expect(feedbackFormsV2Api.draftForm({ description: 'A form', language: 'en', channel: 'link' })).rejects.toThrow('The AI draft came back without a form.')
    })
  })

  describe('the CSV export', () => {
    it('downloads the familiar CSV with the filters by default', async () => {
      fetchMock.mockResolvedValue(new Response('q_feedback,language\nFaster,en\n', { status: 200, headers: { 'Content-Type': 'text/csv' } }))
      const csv = await feedbackFormsV2Api.downloadResponsesCsv('f_1', NO_FILTERS)
      expect(await csv.blob.text()).toBe('q_feedback,language\nFaster,en\n')
      expect(csv.filename).toBeNull()
      expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/feedback-forms/f_1/responses?format=csv&layout=familiar&include_test=false', expect.objectContaining({ method: 'GET' }))
    })

    it('asks for the detailed layout, or a row of ids, and keeps the name the answer gives', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('a', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="form-responses-2026-11-20.csv"' } })))
      const detailed = await feedbackFormsV2Api.downloadResponsesCsv('f_1', NO_FILTERS, { layout: 'detailed', ids: false })
      await feedbackFormsV2Api.downloadResponsesCsv('f_1', NO_FILTERS, { layout: 'familiar', ids: true })
      expect(detailed.filename).toBe('form-responses-2026-11-20.csv')
      expect(fetchMock.mock.calls.map((call) => call[0])).toStrictEqual([
        'https://api.example.com/feedback-forms/f_1/responses?format=csv&layout=detailed&include_test=false',
        'https://api.example.com/feedback-forms/f_1/responses?format=csv&layout=familiar&ids=true&include_test=false',
      ])
    })

    it('is an AuthError when the session is gone, and a FormsApiError when refused', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(json(403, { error: 'Not allowed' }))
      await expect(feedbackFormsV2Api.downloadResponsesCsv('f_1', NO_FILTERS)).rejects.toBeInstanceOf(AuthError)
      await expect(feedbackFormsV2Api.downloadResponsesCsv('f_1', NO_FILTERS)).rejects.toThrow(new FormsApiError(403, 'Not allowed', undefined, { errors: [], retryAfterSeconds: null, current: null }))
    })
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

  it('has none when the route answers null (a language, ending or hidden-value filter), and keeps earlier-version answers apart', () => {
    const [first, ...rest] = answer.questions
    const results = parseFormResults(adaptResults({ ...answer, funnel: null, questions: [{ ...first, earlier_version: 2 }, ...rest] }))
    expect([results.funnel, results.questions['q_reason']?.earlier_version, results.questions['q_nps']?.earlier_version])
      .toStrictEqual([null, 2, undefined])
  })

  it('reads a response row\'s created_at and revision as its time and form revision', () => {
    const page = parseResponsesPage(adaptResponsesPage({ responses: [{ response_id: 'r1', created_at: '2026-11-17T10:00:00Z', revision: 4, language: 'pl', answers: { q_reason: { code: 'price' } }, hidden: {}, ending_id: 'end_thanks', is_test: false }], next_cursor: '50' }))
    expect(page.responses[0]).toStrictEqual(expect.objectContaining({ submitted_at: '2026-11-17T10:00:00Z', form_revision: 4 }))
    expect(page.next_cursor).toBe('50')
  })
})
