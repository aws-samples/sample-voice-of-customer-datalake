/**
 * @fileoverview The six API functions that became assist jobs: each POSTs its
 * route, polls its job read with the started job id, and resolves the job's
 * `result` read into the type it always resolved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { expectFetchedWith, installFetchMock, mockJsonOnce, requestUrl } from '@test/fetch-mock'

const { API } = vi.hoisted(() => ({ API: 'https://api.example.com' }))
vi.mock('../store/configStore', () => import('@test/api-mocks').then(m => m.configStoreMock(API)))
vi.mock('../runtimeConfig', () => import('@test/api-mocks').then(m => m.runtimeConfigMock(API)))
vi.mock('../services/auth', () => import('@test/api-mocks').then(m => m.authServiceMock()))

import { api } from './client'
import { scrapersApi } from './scrapersApi'
import { projectsApi } from './projectsApi'

const STARTED = { success: true, job_id: 'job_9', status: 'pending' }
const post = (body?: unknown) => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const completed = (result: unknown) => ({ success: true, job_id: 'job_9', status: 'completed', result, error: null })

const SELECTORS = {
  container_selector: '.review', text_selector: '.text', confidence: 'high', detected_reviews_count: 12,
}

interface AssistCase {
  name: string
  call: () => Promise<unknown>
  startUrl: string
  startInit: Record<string, unknown>
  pollUrl: string
  result: unknown
  expected: unknown
}

const CASES: AssistCase[] = [
  {
    name: 'generateCategories',
    call: () => api.generateCategories('An online shop'),
    startUrl: `${API}/settings/categories/generate`, startInit: post({ company_description: 'An online shop' }),
    pollUrl: `${API}/settings/jobs/job_9`,
    result: { success: true, categories: [{ id: 'billing', name: 'billing', subcategories: [{ id: 'refunds', name: 'Refunds' }] }] },
    expected: { success: true, categories: [{ id: 'billing', name: 'billing', subcategories: [{ id: 'refunds', name: 'Refunds' }] }] },
  },
  {
    name: 'analyzeUrlForSelectors',
    call: () => scrapersApi.analyzeUrlForSelectors('https://example.com/reviews'),
    startUrl: `${API}/scrapers/analyze-url`, startInit: post({ url: 'https://example.com/reviews' }),
    pollUrl: `${API}/scrapers/jobs/job_9`,
    result: { success: true, selectors: SELECTORS },
    expected: { success: true, selectors: SELECTORS },
  },
  {
    name: 'autofillPrfaqQuestions',
    call: () => projectsApi.autofillPrfaqQuestions('p1', { feature_idea: 'Delay alerts' }),
    startUrl: `${API}/projects/p1/prfaq-autofill`, startInit: post({ feature_idea: 'Delay alerts' }),
    pollUrl: `${API}/projects/p1/jobs/job_9`,
    result: { answers: ['Shoppers', '', 7] },
    expected: { answers: ['Shoppers', ''] },
  },
  {
    name: 'suggestDocumentBrief',
    call: () => projectsApi.suggestDocumentBrief('p1', { doc_type: 'prfaq' }),
    startUrl: `${API}/projects/p1/documents/suggest-brief`, startInit: post({ doc_type: 'prfaq' }),
    pollUrl: `${API}/projects/p1/jobs/job_9`,
    result: { title: 'Delay Alerts', feature_idea: 'Tell customers early.' },
    expected: { title: 'Delay Alerts', feature_idea: 'Tell customers early.' },
  },
  {
    name: 'suggestResearchQuestions',
    call: () => projectsApi.suggestResearchQuestions('p1'),
    startUrl: `${API}/projects/p1/research/suggest-questions`, startInit: post({}),
    pollUrl: `${API}/projects/p1/jobs/job_9`,
    result: { suggestions: [{ title: 'Trust', question: 'Why?' }, { title: 'no question' }] },
    expected: { suggestions: [{ title: 'Trust', question: 'Why?' }] },
  },
  {
    name: 'regeneratePersonaAvatar',
    call: () => projectsApi.regeneratePersonaAvatar('p1', 'persona_1'),
    startUrl: `${API}/projects/p1/personas/persona_1/regenerate-avatar`, startInit: { method: 'POST' },
    pollUrl: `${API}/projects/p1/jobs/job_9`,
    result: { success: true, avatar_url: 'https://cdn.example.com/a.png', avatar_prompt: 'headshot' },
    expected: { avatar_url: 'https://cdn.example.com/a.png' },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  installFetchMock()
})

describe.each(CASES)('$name', ({ call, startUrl, startInit, pollUrl, result, expected }) => {
  it('starts the job on its route and resolves the polled result', async () => {
    mockJsonOnce(STARTED)
    mockJsonOnce(completed(result))

    await expect(call()).resolves.toStrictEqual(expected)

    expectFetchedWith(startUrl, startInit)
    expect(requestUrl(1)).toBe(pollUrl)
  })

  it('rejects with the job error when the job failed', async () => {
    mockJsonOnce(STARTED)
    mockJsonOnce({ success: true, job_id: 'job_9', status: 'failed', error: 'The model is busy', result: null })

    await expect(call()).rejects.toThrow('The model is busy')
  })
})

describe('result normalisation', () => {
  it('regeneratePersonaAvatar reads an empty avatar_url as null', async () => {
    mockJsonOnce(STARTED)
    mockJsonOnce(completed({ success: true, avatar_url: '' }))

    await expect(projectsApi.regeneratePersonaAvatar('p1', 'persona_1')).resolves.toStrictEqual({ avatar_url: null })
  })

  it('analyzeUrlForSelectors keeps a no-selectors answer and its error', async () => {
    mockJsonOnce(STARTED)
    mockJsonOnce(completed({ success: false, error: 'Could not detect reviews' }))

    await expect(scrapersApi.analyzeUrlForSelectors('https://example.com'))
      .resolves.toStrictEqual({ success: false, error: 'Could not detect reviews' })
  })
})

describe('getJobs', () => {
  it('leaves assist jobs out of the Background jobs list', async () => {
    mockJsonOnce({
      success: true,
      jobs: [
        { job_id: 'j1', job_type: 'research', status: 'completed' },
        { job_id: 'j2', job_type: 'assist_persona_avatar', status: 'completed' },
      ],
    })

    const { jobs } = await projectsApi.getJobs('p1')

    expect(jobs.map((job) => job.job_id)).toStrictEqual(['j1'])
  })
})
