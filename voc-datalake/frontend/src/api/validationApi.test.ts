/**
 * @fileoverview The Validate step's client (7.68.00): each call hits its own `/projects/{id}/validation…` route with
 * the body the server reads, the AI calls run as assist jobs polled through the project's job status, and every
 * answer is read leniently (a bad row drops alone, a missing block reads as an empty one).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchApi = vi.hoisted(() => vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>())
const getJobStatus = vi.hoisted(() => vi.fn<(projectId: string, jobId: string) => Promise<{ result?: unknown }>>())
vi.mock('./client', () => ({ fetchApi }))
vi.mock('./projectsApi', () => ({ projectsApi: { getJobStatus } }))
// The job loop itself is api/assistJobs.ts's own spec: here a job starts, is polled once and its result parsed.
vi.mock('./assistJobs', () => ({
  runAssistJob: async (start: () => Promise<unknown>, poll: (jobId: string) => Promise<{ result?: unknown }>,
    parse: (result: unknown) => unknown) => {
    await start()
    return parse((await poll('job_1')).result)
  },
}))

import { validationApi, validationKeys } from './validationApi'

const PROJECT = 'proj/1'
const BASE = '/projects/proj%2F1/validation'
const BLOCK = {
  criteria: [{ id: 'c1', text: 'Paying is quick', target: 4.5 }, { text: 'no id' }, 'junk'],
  tasks: [{ id: 't1', text: 'Pay' }], form_open: true, revision: 3,
}

/** The `index`th fetchApi call: its path, method and JSON body. */
function sent(index = 0): { path?: string; method?: string; body?: unknown } {
  const [path, init] = fetchApi.mock.calls[index] ?? []
  const body = init?.body
  return { path, method: init?.method, body: typeof body === 'string' ? JSON.parse(body) : undefined }
}

/** A job that ends with `result`. */
function jobEnds(result: unknown): void {
  fetchApi.mockResolvedValue({ success: true, job_id: 'job_1' })
  getJobStatus.mockResolvedValue({ result })
}

beforeEach(() => {
  fetchApi.mockReset()
  getJobStatus.mockReset()
})

describe('validationApi', () => {
  it('keys the view by project', () => {
    expect(validationKeys.view('p1')).toStrictEqual(['validation', 'p1'])
  })

  it('reads the view leniently: a bad row drops alone, a missing part reads as none', async () => {
    fetchApi.mockResolvedValue({ validation: BLOCK, criteria: [{ id: 'c1', text: 'Paying is quick' }, 7], tasks: 'x' })
    const view = await validationApi.get(PROJECT)
    expect(fetchApi).toHaveBeenCalledWith(BASE)
    expect(view.validation).toMatchObject({ criteria: [{ id: 'c1', text: 'Paying is quick', target: 4.5 }],
      form_open: true, revision: 3, card_in_prototype: true, form_id: null })
    expect(view.criteria).toStrictEqual([{ id: 'c1', text: 'Paying is quick', target: 4, target_set: false,
      real: { n: 0, average: null }, outcome: 'not_enough_data', synthetic: null }])
    expect([view.tasks, view.form, view.synthetic, view.real, view.decision_prefill]).toStrictEqual([[], null, null, null, null])
  })

  it('reads an answer without its block as an empty one', async () => {
    fetchApi.mockResolvedValue({})
    expect((await validationApi.get(PROJECT)).validation).toMatchObject({ criteria: [], revision: 0, form_open: false })
  })

  it('saves the criteria with the revision the editor loaded', async () => {
    fetchApi.mockResolvedValue({ validation: BLOCK })
    const block = await validationApi.saveCriteria(PROJECT, [{ text: 'Paying is quick', target: 4.5 }], 3)
    expect(sent()).toStrictEqual({ path: `${BASE}/criteria`, method: 'PUT',
      body: { criteria: [{ text: 'Paying is quick', target: 4.5 }], expected_revision: 3 } })
    expect(block.revision).toBe(3)
  })

  it('parses the criteria from the PRD as a job, in the reader\'s language', async () => {
    jobEnds({ validation: BLOCK })
    const block = await validationApi.extractCriteria(PROJECT, true, 'de')
    expect(sent()).toStrictEqual({ path: `${BASE}/criteria`, method: 'POST', body: { replace: true, response_language: 'de' } })
    expect(getJobStatus).toHaveBeenCalledWith(PROJECT, 'job_1')
    expect(block.tasks).toStrictEqual([{ id: 't1', text: 'Pay' }])
  })

  it('writes a blank plan at once, polling nothing', async () => {
    fetchApi.mockResolvedValue({ document_id: 'doc_plan' })
    await expect(validationApi.writePlan(PROJECT, 'blank', 'en')).resolves.toStrictEqual({ document_id: 'doc_plan' })
    expect(sent()).toStrictEqual({ path: `${BASE}/plan`, method: 'POST', body: { mode: 'blank' } })
    expect(getJobStatus).not.toHaveBeenCalled()
  })

  it('writes an AI plan as a job', async () => {
    jobEnds({ document_id: 'doc_ai' })
    await expect(validationApi.writePlan(PROJECT, 'ai', 'fr')).resolves.toStrictEqual({ document_id: 'doc_ai' })
    expect(sent()).toStrictEqual({ path: `${BASE}/plan`, method: 'POST', body: { mode: 'ai', response_language: 'fr' } })
  })

  it('runs the synthetic testers as a job', async () => {
    jobEnds({ document_id: 'doc_run' })
    await expect(validationApi.runSynthetic(PROJECT)).resolves.toStrictEqual({ document_id: 'doc_run' })
    expect(sent()).toStrictEqual({ path: `${BASE}/synthetic`, method: 'POST', body: {} })
  })

  it('saves the card on the prototype\'s pin form with its tasks, state and language', async () => {
    fetchApi.mockResolvedValue({ validation: BLOCK })
    await validationApi.saveCard(PROJECT, { tasks: [{ id: 't1', text: 'Pay' }], open: false, language: 'es',
      expectedRevision: 3 })
    expect(sent()).toStrictEqual({ path: `${BASE}/form`, method: 'PUT',
      body: { tasks: [{ id: 't1', text: 'Pay' }], open: false, language: 'es', expected_revision: 3 } })
  })

  it('writes the report as a job and reads its document and decision prefill', async () => {
    jobEnds({ document_id: 'doc_report', decision_prefill: { title: 'Decide', verdict: 'maybe', rationale: 'r',
      success_metric: 'm' } })
    const answer = await validationApi.writeReport(PROJECT, 'en')
    expect(sent()).toStrictEqual({ path: `${BASE}/report`, method: 'POST', body: { response_language: 'en' } })
    expect(answer).toStrictEqual({ document_id: 'doc_report', decision_prefill: { title: 'Decide', verdict: 'park',
      rationale: 'r', success_metric: 'm', evidence: { document_ids: [], feedback_ids: [] } } })
  })
})
