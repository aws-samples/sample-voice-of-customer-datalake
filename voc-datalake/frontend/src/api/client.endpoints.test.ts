/**
 * @fileoverview Per-endpoint round-trips of the API client: each `api.*` (and
 * `scrapersApi.*`, which owns the /scrapers routes besides the raw list) call hits the right URL with the right method and body and, where the
 * client passes the response through untouched, resolves with it.
 *
 * The request pipeline itself (headers, error bodies, the 401 retry) is
 * covered in `client.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { expectFetchedWith, installFetchMock, mockJsonOnce } from '@test/fetch-mock'

// Only the endpoint is stubbed: these cases assert URL, method and body, so the
// real (unconfigured) auth service and runtime config are fine — headers are
// `client.test.ts`'s concern.
vi.mock('../store/configStore', () => import('@test/api-mocks').then(m => m.configStoreMock('https://api.example.com', { dateBasis: 'imported' })))

import { api } from './client'
import { scrapersApi } from './scrapersApi'
import type { FeedbackForm, ScraperConfig } from './types'

const API = 'https://api.example.com'
const OK = { success: true }

/** One endpoint round-trip. */
interface EndpointCase {
  /** The `api` method under test, for the test title. */
  name: string
  call: () => Promise<unknown>
  /** What the stubbed server answers. */
  response: unknown
  url: string
  /** `method`/`body` the request must carry; omitted for a plain GET (any init). */
  init?: { method: string; body?: string }
  /** The client passes the response through untouched, so the call resolves with it. */
  returnsResponse?: boolean
}

const SCRAPER: ScraperConfig = {
  id: 's1',
  name: 'Test',
  enabled: true,
  base_url: 'https://example.com',
  urls: ['https://example.com/reviews'],
  frequency_minutes: 60,
  container_selector: '.review',
  text_selector: '.text',
  pagination: { enabled: false, param: 'page', max_pages: 1, start: 1 },
}

const NEW_FORM: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> = {
  name: 'New Form',
  enabled: true,
  category: '',
  subcategory: '',
  title: 'Tell us',
  description: '',
  question: 'How was it?',
  placeholder: '',
  rating_enabled: false,
  rating_type: 'stars',
  rating_max: 5,
  submit_button_text: 'Send',
  success_message: 'Thanks',
  theme: { primary_color: '#000000', background_color: '#ffffff', text_color: '#000000', border_radius: '4px' },
  collect_email: false,
  collect_name: false,
  custom_fields: [],
}

const BRAND_SETTINGS = {
  brand_name: 'Updated Brand',
  brand_handles: ['@updated'],
  hashtags: ['#test'],
  urls_to_track: ['https://example.com'],
}
const CATEGORIES_CONFIG = { categories: [{ id: 'cat1', name: 'Category 1', subcategories: [] }] }
const CREDENTIALS = { api_key: 'test-key', api_secret: 'test-secret' }
const NEW_USER = { username: 'new-user', email: 'new@example.com', name: 'New User', group: 'users' as const }
const PROJECT_DATA = { name: 'New Project', description: 'Test' }
const REVIEWS = [{ text: 'Review 1', rating: 5, author: null, date: null, title: null }]
const CHANGED_SCORES = {
  doc1: { row_id: 'doc1', impact: 4, time_to_market: 2, confidence: 3, strategic_fit: 4, notes: 'test' },
}
const EXPLORER_EDIT = { original_text: 'Updated feedback' }

const post = (body?: unknown) => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const put = (body?: unknown) => ({ method: 'PUT', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const DELETE = { method: 'DELETE' }

const METRICS_CASES: EndpointCase[] = [
  { name: 'getUrgentFeedback', call: () => api.getUrgentFeedback({ days: 7, limit: 10 }), response: { count: 3, items: [] }, url: `${API}/feedback/urgent?days=7&limit=10` },
  { name: 'getSummary', call: () => api.getSummary({ days: 30 }), response: { total_feedback: 100, avg_sentiment: 0.5 }, url: `${API}/metrics/summary?days=30`, returnsResponse: true },
  { name: 'getSummary (source filter)', call: () => api.getSummary({ days: 7 }, 'webscraper'), response: {}, url: `${API}/metrics/summary?days=7&source=webscraper` },
  { name: 'getSummary (custom rolling window)', call: () => api.getSummary({ days: 21 }), response: {}, url: `${API}/metrics/summary?days=21` },
  { name: 'getSentiment', call: () => api.getSentiment({ days: 7 }), response: { breakdown: { positive: 60, negative: 20, neutral: 20 } }, url: `${API}/metrics/sentiment?days=7`, returnsResponse: true },
  { name: 'getCategories', call: () => api.getCategories({ days: 14 }), response: { categories: { delivery: 50, quality: 30 } }, url: `${API}/metrics/categories?days=14`, returnsResponse: true },
  { name: 'getSources', call: () => api.getSources({ days: 7 }), response: { sources: { webscraper: 100, manual_import: 50 } }, url: `${API}/metrics/sources?days=7`, returnsResponse: true },
  { name: 'getGithubMetrics', call: () => api.getGithubMetrics({ days: 7 }, 'acme/Kiro'), response: { total: 0 }, url: `${API}/metrics/github?days=7&repo=acme%2FKiro` },
  // Contract archetype codes, which is what this route returns: the persona axis
  // buckets on `persona_type` and is closed to the enrichment enum.
  { name: 'getPersonas', call: () => api.getPersonas({ days: 7 }), response: { period_days: 7, personas: { existing_customer: 50, churn_risk: 30 } }, url: `${API}/metrics/personas?days=7`, returnsResponse: true },
  { name: 'getPersonas (source filter)', call: () => api.getPersonas({ days: 7 }, 'webscraper'), response: { period_days: 7, personas: {} }, url: `${API}/metrics/personas?days=7&source=webscraper` },
  { name: 'getEntities', call: () => api.getEntities({ days: 30, limit: 10, source: 'webscraper' }), response: { entities: { keywords: [], categories: [], issues: [] } }, url: `${API}/feedback/entities?days=30&limit=10&source=webscraper` },
  { name: 'searchFeedback', call: () => api.searchFeedback({ q: 'delivery issues', days: 30, limit: 20 }), response: { count: 5, items: [], entities: {}, query: 'test' }, url: `${API}/feedback/search?q=delivery+issues&days=30&limit=20` },
  { name: 'getSimilarFeedback', call: () => api.getSimilarFeedback('abc123', 5), response: { source_feedback_id: 'abc', count: 3, items: [] }, url: `${API}/feedback/abc123/similar?limit=5` },
]

const SCRAPER_CASES: EndpointCase[] = [
  { name: 'getScrapers', call: () => api.getScrapers(), response: { scrapers: [{ id: 's1', name: 'Test Scraper' }] }, url: `${API}/scrapers`, returnsResponse: true },
  { name: 'saveScraper', call: () => scrapersApi.saveScraper(SCRAPER), response: { success: true, scraper: SCRAPER }, url: `${API}/scrapers`, init: post({ scraper: SCRAPER }) },
  { name: 'deleteScraper', call: () => scrapersApi.deleteScraper('scraper-123'), response: OK, url: `${API}/scrapers/scraper-123`, init: DELETE },
  { name: 'getScraperTemplates', call: () => scrapersApi.getScraperTemplates(), response: { templates: [{ id: 't1', name: 'Template 1' }] }, url: `${API}/scrapers/templates`, returnsResponse: true },
  { name: 'analyzeUrlForSelectors', call: () => scrapersApi.analyzeUrlForSelectors('https://example.com/reviews'), response: { success: true, selectors: { container_selector: '.review' } }, url: `${API}/scrapers/analyze-url`, init: post({ url: 'https://example.com/reviews' }) },
  { name: 'runScraper', call: () => scrapersApi.runScraper('scraper-123'), response: { success: true, execution_id: 'exec-1', status: 'running' }, url: `${API}/scrapers/scraper-123/run`, init: post() },
  { name: 'getScraperStatus', call: () => scrapersApi.getScraperStatus('s1'), response: { scraper_id: 's1', status: 'completed', pages_scraped: 5, items_found: 50 }, url: `${API}/scrapers/s1/status` },
  { name: 'getScraperRuns', call: () => scrapersApi.getScraperRuns('s1'), response: { runs: [{ sk: 'run-1', status: 'completed' }] }, url: `${API}/scrapers/s1/runs`, returnsResponse: true },
  { name: 'startManualImportParse', call: () => scrapersApi.startManualImportParse('https://example.com', 'Review text here'), response: { success: true, job_id: 'job-1' }, url: `${API}/scrapers/manual/parse`, init: post({ source_url: 'https://example.com', raw_text: 'Review text here' }) },
  { name: 'getManualImportStatus', call: () => scrapersApi.getManualImportStatus('job-1'), response: { status: 'completed', reviews: [{ text: 'Review 1' }] }, url: `${API}/scrapers/manual/parse/job-1`, returnsResponse: true },
  { name: 'confirmManualImport', call: () => scrapersApi.confirmManualImport('job-1', REVIEWS), response: { success: true, imported_count: 1 }, url: `${API}/scrapers/manual/confirm`, init: post({ job_id: 'job-1', reviews: REVIEWS }) },
]

const SETTINGS_CASES: EndpointCase[] = [
  { name: 'createProject', call: () => api.createProject(PROJECT_DATA), response: { success: true, project: { ...PROJECT_DATA, id: 'p1' } }, url: `${API}/projects`, init: post(PROJECT_DATA) },
  { name: 'getBrandSettings', call: () => api.getBrandSettings(), response: { brand_name: 'Test Brand', brand_handles: ['@test'] }, url: `${API}/settings/brand`, returnsResponse: true },
  { name: 'saveBrandSettings', call: () => api.saveBrandSettings(BRAND_SETTINGS), response: { success: true, message: 'Saved' }, url: `${API}/settings/brand`, init: put(BRAND_SETTINGS) },
  { name: 'getCategoriesConfig', call: () => api.getCategoriesConfig(), response: CATEGORIES_CONFIG, url: `${API}/settings/categories`, returnsResponse: true },
  { name: 'saveCategoriesConfig', call: () => api.saveCategoriesConfig(CATEGORIES_CONFIG), response: { success: true, message: 'Saved' }, url: `${API}/settings/categories`, init: put(CATEGORIES_CONFIG) },
  { name: 'generateCategories', call: () => api.generateCategories('We are an e-commerce company'), response: { success: true, categories: [] }, url: `${API}/settings/categories/generate`, init: post({ company_description: 'We are an e-commerce company' }) },
  { name: 'getIntegrationStatus', call: () => api.getIntegrationStatus(), response: { webscraper: { configured: true, credentials_set: ['api_key'] } }, url: `${API}/integrations/status`, returnsResponse: true },
  { name: 'updateIntegrationCredentials', call: () => api.updateIntegrationCredentials('webscraper', CREDENTIALS), response: { success: true, message: 'Updated' }, url: `${API}/integrations/webscraper/credentials`, init: put(CREDENTIALS) },
  { name: 'testIntegration', call: () => api.testIntegration('webscraper'), response: { success: true, message: 'Connection successful' }, url: `${API}/integrations/webscraper/test`, init: post() },
  { name: 'getSourcesStatus', call: () => api.getSourcesStatus(), response: { sources: { webscraper: { enabled: true, schedule: 'rate(5 minutes)' } } }, url: `${API}/sources/status`, returnsResponse: true },
  { name: 'enableSource', call: () => api.enableSource('webscraper'), response: { success: true, source: 'webscraper', enabled: true }, url: `${API}/sources/webscraper/enable`, init: put() },
  { name: 'disableSource', call: () => api.disableSource('webscraper'), response: { success: true, source: 'webscraper', enabled: false }, url: `${API}/sources/webscraper/disable`, init: put() },
  { name: 'patchPrioritizationScores', call: () => api.patchPrioritizationScores(CHANGED_SCORES), response: { success: true, updated_count: 1 }, url: `${API}/projects/prioritization`, init: { method: 'PATCH', body: JSON.stringify({ scores: CHANGED_SCORES }) } },
]

const FORMS_AND_USERS_CASES: EndpointCase[] = [
  { name: 'getFeedbackForms', call: () => api.getFeedbackForms(), response: { success: true, forms: [{ form_id: 'f1', name: 'Form 1' }] }, url: `${API}/feedback-forms`, returnsResponse: true },
  { name: 'createFeedbackForm', call: () => api.createFeedbackForm(NEW_FORM), response: { success: true, form: { ...NEW_FORM, form_id: 'f1' } }, url: `${API}/feedback-forms`, init: post(NEW_FORM) },
  { name: 'updateFeedbackForm', call: () => api.updateFeedbackForm('f1', { name: 'Updated Form' }), response: { success: true, form: { form_id: 'f1', name: 'Updated Form' } }, url: `${API}/feedback-forms/f1`, init: put({ name: 'Updated Form' }) },
  { name: 'deleteFeedbackForm', call: () => api.deleteFeedbackForm('f1'), response: OK, url: `${API}/feedback-forms/f1`, init: DELETE },
  { name: 'getUsers', call: () => api.getUsers(), response: { success: true, users: [{ username: 'user1', email: 'user1@example.com' }] }, url: `${API}/users`, returnsResponse: true },
  { name: 'createUser', call: () => api.createUser(NEW_USER), response: { success: true, message: 'User created' }, url: `${API}/users`, init: post(NEW_USER) },
  { name: 'updateUserGroup', call: () => api.updateUserGroup('user1', 'admins'), response: { success: true, message: 'Updated' }, url: `${API}/users/user1/group`, init: put({ group: 'admins' }) },
  { name: 'resetUserPassword', call: () => api.resetUserPassword('user1'), response: { success: true, message: 'Password reset' }, url: `${API}/users/user1/reset-password`, init: post() },
  { name: 'enableUser', call: () => api.enableUser('user1'), response: { success: true, message: 'User enabled' }, url: `${API}/users/user1/enable`, init: put() },
  { name: 'disableUser', call: () => api.disableUser('user1'), response: { success: true, message: 'User disabled' }, url: `${API}/users/user1/disable`, init: put() },
  { name: 'deleteUser', call: () => api.deleteUser('user1'), response: { success: true, message: 'User deleted' }, url: `${API}/users/user1`, init: DELETE },
]

const DATA_CASES: EndpointCase[] = [
  { name: 'getS3ImportSources', call: () => api.getS3ImportSources(), response: { sources: [{ name: 'default', display_name: 'Default' }], bucket: 'test-bucket' }, url: `${API}/s3-import/sources`, returnsResponse: true },
  { name: 'createS3ImportSource', call: () => api.createS3ImportSource('new-source'), response: { success: true, source: { name: 'new-source' } }, url: `${API}/s3-import/sources`, init: post({ name: 'new-source' }) },
  { name: 'getS3ImportFiles', call: () => api.getS3ImportFiles({ source: 'default', include_processed: true }), response: { files: [], bucket: 'test-bucket' }, url: `${API}/s3-import/files?source=default&include_processed=true` },
  { name: 'deleteS3ImportFile', call: () => api.deleteS3ImportFile('default/file.json'), response: OK, url: `${API}/s3-import/file/default%2Ffile.json`, init: DELETE },
  { name: 'getS3UploadUrl', call: () => api.getS3UploadUrl('file.json', 'default', 'application/json'), response: { success: true, upload_url: 'https://s3.example.com/upload' }, url: `${API}/s3-import/upload-url`, init: post({ filename: 'file.json', source: 'default', content_type: 'application/json' }) },
  { name: 'getDataExplorerBuckets', call: () => api.getDataExplorerBuckets(), response: { buckets: [{ id: 'raw', name: 'voc-raw-data', label: 'Raw Data' }] }, url: `${API}/data-explorer/buckets`, returnsResponse: true },
  { name: 'getDataExplorerS3', call: () => api.getDataExplorerS3('raw/', 'test-bucket'), response: { objects: [], bucket: 'test', prefix: 'raw/' }, url: `${API}/data-explorer/s3?prefix=raw%2F&bucket=test-bucket` },
  { name: 'getDataExplorerS3Preview', call: () => api.getDataExplorerS3Preview('raw/file.json', 'test-bucket'), response: { content: { test: 'data' }, size: 100 }, url: `${API}/data-explorer/s3/preview?key=raw%2Ffile.json&bucket=test-bucket` },
  { name: 'saveDataExplorerS3', call: () => api.saveDataExplorerS3('raw/file.json', '{"test": "data"}', true, 'test-bucket'), response: OK, url: `${API}/data-explorer/s3`, init: put({ key: 'raw/file.json', content: '{"test": "data"}', sync_to_dynamo: true, bucket: 'test-bucket' }) },
  // No S3 sync flag: a feedback edit only touches the DynamoDB record.
  { name: 'saveDataExplorerFeedback', call: () => api.saveDataExplorerFeedback('fb-1', EXPLORER_EDIT), response: OK, url: `${API}/data-explorer/feedback`, init: put({ feedback_id: 'fb-1', data: EXPLORER_EDIT }) },
]

const LOGS_CASES: EndpointCase[] = [
  { name: 'getValidationLogs (defaults)', call: () => api.getValidationLogs(), response: { logs: [], count: 0, days: 7 }, url: `${API}/logs/validation?`, returnsResponse: true },
  { name: 'getValidationLogs (filters)', call: () => api.getValidationLogs({ source: 'webscraper', days: 7, limit: 50 }), response: { logs: [{ source_platform: 'webscraper', message_id: 'msg-1' }], count: 1, days: 7 }, url: `${API}/logs/validation?source=webscraper&days=7&limit=50` },
  { name: 'getProcessingLogs', call: () => api.getProcessingLogs({ days: 7 }), response: { logs: [{ error_type: 'BedrockError', error_message: 'Failed' }], count: 1, days: 7 }, url: `${API}/logs/processing?days=7`, returnsResponse: true },
  {
    name: 'getLogsSummary',
    call: () => api.getLogsSummary(7),
    response: {
      summary: {
        validation_failures: { webscraper: 5 },
        processing_errors: { manual_import: 2 },
        total_validation_failures: 5,
        total_processing_errors: 2,
      },
      days: 7,
    },
    url: `${API}/logs/summary?days=7`,
    returnsResponse: true,
  },
  { name: 'getLogsSummary (default days)', call: () => api.getLogsSummary(), response: { summary: {}, days: 7 }, url: `${API}/logs/summary?` },
  {
    name: 'getScraperLogs',
    call: () => api.getScraperLogs('scraper-123', { days: 7, limit: 10 }),
    response: { scraper_id: 'scraper-123', logs: [{ run_id: 'run-1', status: 'completed', pages_scraped: 10 }], count: 1 },
    url: `${API}/logs/scraper/scraper-123?days=7&limit=10`,
    returnsResponse: true,
  },
  { name: 'clearValidationLogs', call: () => api.clearValidationLogs('webscraper'), response: { success: true, deleted: 5 }, url: `${API}/logs/validation/webscraper`, init: DELETE, returnsResponse: true },
]

beforeEach(() => {
  vi.clearAllMocks()
  installFetchMock()
})

describe.each([
  ['metrics and search', METRICS_CASES],
  ['scrapers and manual import', SCRAPER_CASES],
  ['settings, integrations and projects', SETTINGS_CASES],
  ['feedback forms and users', FORMS_AND_USERS_CASES],
  ['S3 import and data explorer', DATA_CASES],
  ['logs', LOGS_CASES],
])('%s endpoints', (_group, cases) => {
  it.each(cases)('$name requests $url', async ({ call, response, url, init }) => {
    mockJsonOnce(response)

    await call()

    expectFetchedWith(url, init)
  })

  const passThrough = cases.filter((c) => c.returnsResponse === true)
  it.each(passThrough)('$name resolves with the response untouched', async ({ call, response }) => {
    mockJsonOnce(response)

    await expect(call()).resolves.toStrictEqual(response)
  })
})

describe('getProjects', () => {
  it('fetches projects list and normalizes each row', async () => {
    mockJsonOnce({ projects: [{ project_id: 'p1', name: 'Project 1' }] })

    const result = await api.getProjects()

    expectFetchedWith(`${API}/projects`)
    expect(result.projects.map((p) => p.project_id)).toStrictEqual(['p1'])
  })
})

describe('getPrioritizationScores', () => {
  it('fetches prioritization scores', async () => {
    const scores = { scores: { issue1: { impact: 5, effort: 3 } } }
    mockJsonOnce(scores)

    const result = await api.getPrioritizationScores()

    expectFetchedWith(`${API}/projects/prioritization`)
    expect(result).toStrictEqual(scores)
  })

  it('passes through the aggregates the endpoint returns beside scores', async () => {
    // `aggregates` exists so a later frontend change can show what every
    // reviewer together said. Type-erasing it would leave the next author
    // reaching for a cast, with nothing saying the field is already on the wire.
    mockJsonOnce({
      scores: {
        doc1: { document_id: 'doc1', impact: 5, time_to_market: 3, confidence: 2, strategic_fit: 4, notes: '' },
      },
      aggregates: {
        doc1: { impact: 4, time_to_market: 3, confidence: 2, strategic_fit: 4, reviewer_count: 2, score_spread: 0.4 },
      },
    })

    const result = await api.getPrioritizationScores()

    expect(result.aggregates?.['doc1']).toMatchObject({ reviewer_count: 2, score_spread: 0.4 })
  })

  it('still resolves when an older deployment omits aggregates', async () => {
    // Which is why the field is optional in the type rather than required.
    mockJsonOnce({ scores: {} })

    const result = await api.getPrioritizationScores()

    expect(result.aggregates).toBeUndefined()
  })
})

describe('removed calls', () => {
  it('has no savePrioritizationScores, because a whole-map PUT overwrote every reviewer', () => {
    // Scores are per-reviewer ballots now, so one caller's map is not
    // everyone's scores. The endpoint refuses PUT, so a client function for it
    // could only ever produce a 400.
    expect('savePrioritizationScores' in api).toBe(false)
  })

  it('exposes no data-explorer delete calls (customer data is never deleted)', () => {
    expect(api).not.toHaveProperty('deleteDataExplorerS3')
    expect(api).not.toHaveProperty('deleteDataExplorerFeedback')
  })
})
