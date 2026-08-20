/**
 * @fileoverview Tests for API client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Mock defaults, shared between the `vi.mock` factories below and the
 * `beforeEach` that restores them.
 *
 * `vi.hoisted` is what makes the sharing possible: the factories are hoisted
 * above the imports, so a plain module-level `const` would still be in its
 * temporal dead zone when a factory first runs.
 *
 * They have to be restored per-test, not just declared once, because neither
 * hook in this suite puts back the implementation of a `vi.fn(impl)` created
 * inside a `vi.mock` factory: `vi.clearAllMocks()` only drops call history, and
 * `vi.restoreAllMocks()` only reverts `vi.spyOn` spies. So a test calling
 * `mockReturnValue` on `getRuntimeConfig` changed the trusted-origin allowlist
 * for every test after it in this file. Confirmed under vitest 4.1.11: an
 * override set in one test was still in force in the next.
 *
 * Nothing was failing because of it — the one test that asserts on the
 * Authorization header runs before the override, and none after it look at the
 * header. That ordering was the only thing keeping the file green, which is the
 * reason to fix it rather than leave it.
 */
const {
  DEFAULT_ENDPOINT, DEFAULT_ID_TOKEN, DEFAULT_RUNTIME_CONFIG, DEFAULT_STORE_STATE,
} = vi.hoisted(() => {
  const endpoint = 'https://api.example.com'
  return {
    DEFAULT_ENDPOINT: endpoint,
    DEFAULT_ID_TOKEN: 'mock-id-token',
    DEFAULT_RUNTIME_CONFIG: {
      apiEndpoint: endpoint,
      cognito: {
        userPoolId: 'pool-1',
        clientId: 'client-1',
        region: 'us-east-1',
        identityPoolId: 'id-pool',
      },
    },
    DEFAULT_STORE_STATE: {
      config: { apiEndpoint: endpoint },
      dateBasis: 'imported',
    },
  }
})

// Mock stores and auth before importing client
vi.mock('../store/configStore', () => ({
  useConfigStore: {
    getState: vi.fn(() => DEFAULT_STORE_STATE),
  },
}))

// The origin-check in baseUrl.ts reads the runtime config to build the
// trusted-origins allowlist. Without this mock, isConfigLoaded() returns
// false, the allowlist is empty, and Authorization is never attached —
// breaking every test that asserts the header is present.
vi.mock('../runtimeConfig', () => ({
  isConfigLoaded: vi.fn(() => true),
  getRuntimeConfig: vi.fn(() => DEFAULT_RUNTIME_CONFIG),
}))

vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(() => true),
    getIdToken: vi.fn(() => DEFAULT_ID_TOKEN),
    getAccessToken: vi.fn(() => Promise.resolve('mock-access-token')),
    refreshSession: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn(),
  },
}))

import { api, getDaysFromRange, getDateRangeParams, ALL_TIME_DAYS } from './client'
import { authService } from '../services/auth'
import * as runtimeConfig from '../runtimeConfig'
import { useConfigStore } from '../store/configStore'
import { SESSION_EXPIRED_PATH, resetSessionExpiryForTests } from '../services/sessionExpiry'

describe('API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-establish the mock implementations, which clearAllMocks does not.
    // See the note on DEFAULT_RUNTIME_CONFIG: without this, a test that
    // overrides the runtime config leaks a foreign trusted-origin allowlist
    // into every test after it.
    vi.mocked(runtimeConfig.isConfigLoaded).mockReturnValue(true)
    vi.mocked(runtimeConfig.getRuntimeConfig).mockReturnValue(DEFAULT_RUNTIME_CONFIG)
    // The 401-retry tests reach inside `refreshSession` to re-point
    // `getIdToken` at a fresh token; both overrides survive the hooks the same
    // way, so both are restored here. Found by the regression guard below, not
    // by inspection — it failed on `getIdToken` still returning 'fresh-token'.
    vi.mocked(authService.getIdToken).mockReturnValue(DEFAULT_ID_TOKEN)
    // These two go through the file's existing `as ReturnType<typeof vi.fn>`
    // idiom rather than `vi.mocked`, because the mocks are deliberately PARTIAL:
    // the store state carries only the two fields the client reads (a whole
    // `ConfigStore` would mean stubbing every setter), and `refreshSession`
    // resolves `undefined` rather than a `CognitoUserSession` nobody asserts on.
    // `vi.mocked` type-checks the argument and would reject both — and since
    // `tsconfig.app.json` excludes test files, that rejection would not surface
    // in `npm run check`, only in the un-gated `typecheck:tests` baseline.
    ;(useConfigStore.getState as ReturnType<typeof vi.fn>).mockReturnValue(DEFAULT_STORE_STATE)
    ;(authService.refreshSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getFeedback', () => {
    it('fetches feedback with correct query parameters', async () => {
      const mockResponse = { count: 2, items: [{ feedback_id: '1' }, { feedback_id: '2' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.getFeedback({ days: 7, source: 'webscraper' })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback?days=7&source=webscraper',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'mock-id-token',
          }),
        })
      )
      // Items are normalized to the FeedbackItem contract at the client boundary.
      expect(result.count).toBe(2)
      expect(result.items.map((i) => i.feedback_id)).toEqual(['1', '2'])
    })

    it('throws error on non-ok response', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

      await expect(api.getFeedback({ days: 7 })).rejects.toThrow('API Error: 500')
    })

    it('includes all filter parameters when provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ count: 0, items: [] }),
      })

      await api.getFeedback({ 
        days: 30, 
        source: 'webscraper', 
        category: 'delivery', 
        sentiment: 'negative',
        limit: 50 
      })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('days=30'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('source=webscraper'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('category=delivery'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('sentiment=negative'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=50'),
        expect.any(Object)
      )
    })

    it('omits undefined parameters from query string', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ count: 0, items: [] }),
      })

      await api.getFeedback({ days: 7 })

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(calledUrl).not.toContain('source=')
      expect(calledUrl).not.toContain('category=')
    })
  })

  describe('401 handling', () => {
    it('refreshes session and retries on 401 response', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ count: 0, items: [] }) })

      await api.getFeedback({ days: 7 })

      expect(authService.refreshSession).toHaveBeenCalled()
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    /**
     * The 401 retry must re-run the origin check, not just re-send the token.
     *
     * `handleUnauthorized` rebuilds headers through `buildHeaders(…, fullUrl)`
     * so a server that answers the first (unauthenticated) request with 401
     * cannot collect the refreshed token on the second. These two cases pin
     * that: the trusted one proves the retry does carry the fresh token, so
     * the untrusted one cannot pass just because the header stopped being
     * attached at all.
     *
     * Both fail if `handleUnauthorized` goes back to writing
     * `authService.getIdToken()` into a mutated headers object.
     */
    it('carries the refreshed token on the retry when the origin is trusted', async () => {
      ;(authService.refreshSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        ;(authService.getIdToken as ReturnType<typeof vi.fn>).mockReturnValue('fresh-token')
        return Promise.resolve(undefined)
      })
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ count: 0, items: [] }) })

      await api.getFeedback({ days: 7 })

      // Rebuilt headers re-read the token, so the retry carries the new one
      // rather than the one that just 401'd.
      const [, retryInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
      expect(retryInit.headers['Authorization']).toBe('fresh-token')
    })

    it('does NOT attach Authorization on the retry when the origin is untrusted', async () => {
      // The deployment's real endpoint is elsewhere, so the configured base URL
      // (DEFAULT_ENDPOINT — e.g. a stale persisted value) is foreign.
      // This override is undone by the suite's beforeEach, which re-applies
      // DEFAULT_RUNTIME_CONFIG; `vi.clearAllMocks()` alone would leave it in
      // place for every later test in this file.
      vi.mocked(runtimeConfig.getRuntimeConfig).mockReturnValue({
        ...DEFAULT_RUNTIME_CONFIG,
        apiEndpoint: 'https://deployment.example.com/v1',
      })
      expect(DEFAULT_ENDPOINT).not.toContain('deployment.example.com')
      ;(authService.refreshSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        ;(authService.getIdToken as ReturnType<typeof vi.fn>).mockReturnValue('fresh-token')
        return Promise.resolve(undefined)
      })
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ count: 0, items: [] }) })

      await api.getFeedback({ days: 7 })

      expect(global.fetch).toHaveBeenCalledTimes(2)
      const [, firstInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      const [, retryInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
      // Withheld on the first request…
      expect(firstInit.headers['Authorization']).toBeUndefined()
      // …and still withheld after the refresh, which is the property the
      // rebuilt headers exist to guarantee.
      expect(retryInit.headers['Authorization']).toBeUndefined()
    })

    /**
     * Regression guard for the overrides in the two tests above.
     *
     * Order-dependence is inherent, not an oversight: a leak detector has to run
     * AFTER the test that leaks, so this must stay below the untrusted-origin
     * case. Making it order-INDEPENDENT would also make it useless — with no
     * preceding override there is nothing left behind to detect.
     *
     * Two assertions on purpose. The first reads the mock state directly, so a
     * failure names the cause ("the runtime config is still the previous test's
     * foreign endpoint"). The second checks the consequence the cause produces,
     * so the guard still fires if some future leak reaches the request by another
     * route. Either fails if `beforeEach` stops re-applying the defaults.
     */
    it('starts from the default trusted allowlist, not the previous test override', async () => {
      // Cause: the mocks are back at their defaults.
      expect(runtimeConfig.getRuntimeConfig().apiEndpoint).toBe(DEFAULT_ENDPOINT)
      expect(authService.getIdToken()).toBe(DEFAULT_ID_TOKEN)

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ count: 0, items: [] }),
      })

      await api.getFeedback({ days: 7 })

      // Consequence: the request goes to the trusted origin, carrying the token.
      const [calledUrl, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(calledUrl).toContain(DEFAULT_ENDPOINT)
      expect(init.headers['Authorization']).toBe(DEFAULT_ID_TOKEN)
    })

    it('signs out and redirects with a reason when refresh fails', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: false, status: 401 })

      const originalLocation = window.location
      const replace = vi.fn()
      Object.defineProperty(window, 'location', {
        value: { href: '', replace },
        writable: true,
      })
      // The redirect is idempotent and only a real page load resets it.
      resetSessionExpiryForTests()

      await expect(api.getFeedback({ days: 7 })).rejects.toThrow('Session expired')
      expect(authService.signOut).toHaveBeenCalled()
      // The reason must travel with the redirect: without it /login cannot
      // tell the user why the app they were using stopped working.
      expect(replace).toHaveBeenCalledWith(SESSION_EXPIRED_PATH)

      window.location = originalLocation
    })
  })

  describe('getFeedbackById', () => {
    it('fetches single feedback item by id', async () => {
      const mockFeedback = { feedback_id: 'abc123', text: 'Test feedback' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockFeedback),
      })

      const result = await api.getFeedbackById('abc123')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback/abc123',
        expect.any(Object)
      )
      // Response is normalized to the FeedbackItem contract at the client boundary.
      expect(result.feedback_id).toBe('abc123')
    })
  })

  describe('getUrgentFeedback', () => {
    it('fetches urgent feedback with parameters', async () => {
      const mockResponse = { count: 3, items: [] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await api.getUrgentFeedback({ days: 7, limit: 10 })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback/urgent?days=7&limit=10',
        expect.any(Object)
      )
    })
  })

  describe('getSummary', () => {
    it('fetches summary with days parameter', async () => {
      const mockSummary = { total_feedback: 100, avg_sentiment: 0.5 }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSummary),
      })

      const result = await api.getSummary({ days: 30 })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/summary?days=30',
        expect.any(Object)
      )
      expect(result).toEqual(mockSummary)
    })

    it('includes source filter when provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      })

      await api.getSummary({ days: 7 }, 'webscraper')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/summary?days=7&source=webscraper',
        expect.any(Object)
      )
    })

    it('sends a rolling day count for a custom window', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      })

      await api.getSummary({ days: 21 })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/summary?days=21',
        expect.any(Object)
      )
    })
  })

  describe('getSentiment', () => {
    it('fetches sentiment breakdown', async () => {
      const mockSentiment = { breakdown: { positive: 60, negative: 20, neutral: 20 } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSentiment),
      })

      const result = await api.getSentiment({ days: 7 })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/sentiment?days=7',
        expect.any(Object)
      )
      expect(result).toEqual(mockSentiment)
    })
  })

  describe('getCategories', () => {
    it('fetches category breakdown', async () => {
      const mockCategories = { categories: { delivery: 50, quality: 30 } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCategories),
      })

      const result = await api.getCategories({ days: 14 })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/categories?days=14',
        expect.any(Object)
      )
      expect(result).toEqual(mockCategories)
    })
  })

  describe('getSources', () => {
    it('fetches source breakdown', async () => {
      const mockSources = { sources: { webscraper: 100, manual_import: 50 } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSources),
      })

      const result = await api.getSources({ days: 7 })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/sources?days=7',
        expect.any(Object)
      )
      expect(result).toEqual(mockSources)
    })
  })

  describe('chat', () => {
    it('sends POST request with message body', async () => {
      const mockResponse = { response: 'AI response', sources: [] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.chat('What do customers think?')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/chat',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'What do customers think?', context: undefined }),
        })
      )
      expect(result).toEqual(mockResponse)
    })

    it('includes context when provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ response: 'Response' }),
      })

      await api.chat('Question', 'Additional context')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/chat',
        expect.objectContaining({
          body: JSON.stringify({ message: 'Question', context: 'Additional context' }),
        })
      )
    })

    it('threads the review date basis into the body (issue #150)', async () => {
      ;(useConfigStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
        ...DEFAULT_STORE_STATE,
        dateBasis: 'review',
      })
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ response: 'Response' }),
      })

      await api.chat('Question')

      const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(JSON.parse(options.body)).toMatchObject({ date_basis: 'review' })
    })

    it('omits date_basis on the default imported basis', async () => {
      // No override needed: 'imported' is the default the beforeEach restores.
      // Asserting it from the restored default is the point — if the previous
      // test's 'review' leaked, this would fail.
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ response: 'Response' }),
      })

      await api.chat('Question')

      const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(JSON.parse(options.body)).not.toHaveProperty('date_basis')
    })
  })

  describe('getScrapers', () => {
    it('fetches scraper configurations', async () => {
      const mockScrapers = { scrapers: [{ id: 's1', name: 'Test Scraper' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScrapers),
      })

      const result = await api.getScrapers()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers',
        expect.any(Object)
      )
      expect(result).toEqual(mockScrapers)
    })
  })

  describe('saveScraper', () => {
    it('sends POST request with scraper config', async () => {
      const scraper = { id: 's1', name: 'Test', enabled: true } as any
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, scraper }),
      })

      await api.saveScraper(scraper)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ scraper }),
        })
      )
    })
  })

  describe('deleteScraper', () => {
    it('sends DELETE request for scraper', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await api.deleteScraper('scraper-123')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/scraper-123',
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('getProjects', () => {
    it('fetches projects list', async () => {
      const mockProjects = { projects: [{ id: 'p1', name: 'Project 1' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockProjects),
      })

      const result = await api.getProjects()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects',
        expect.any(Object)
      )
      expect(result).toEqual(mockProjects)
    })
  })

  describe('createProject', () => {
    it('sends POST request with project data', async () => {
      const projectData = { name: 'New Project', description: 'Test' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, project: { ...projectData, id: 'p1' } }),
      })

      await api.createProject(projectData)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(projectData),
        })
      )
    })
  })

  describe('getUsers', () => {
    it('fetches users list', async () => {
      const mockUsers = { success: true, users: [{ username: 'user1', email: 'user1@example.com' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockUsers),
      })

      const result = await api.getUsers()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/users',
        expect.any(Object)
      )
      expect(result).toEqual(mockUsers)
    })
  })

  describe('createUser', () => {
    it('sends POST request with user data', async () => {
      const userData = { email: 'new@example.com', name: 'New User', group: 'viewers' as const }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'User created' }),
      })

      await api.createUser(userData)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/users',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(userData),
        })
      )
    })
  })

  describe('getBrandSettings', () => {
    it('fetches brand settings', async () => {
      const mockSettings = { brand_name: 'Test Brand', brand_handles: ['@test'] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSettings),
      })

      const result = await api.getBrandSettings()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/settings/brand',
        expect.any(Object)
      )
      expect(result).toEqual(mockSettings)
    })
  })

  describe('saveBrandSettings', () => {
    it('sends PUT request with brand settings', async () => {
      const settings = {
        brand_name: 'Updated Brand',
        brand_handles: ['@updated'],
        hashtags: ['#test'],
        urls_to_track: ['https://example.com'],
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'Saved' }),
      })

      await api.saveBrandSettings(settings)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/settings/brand',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(settings),
        })
      )
    })
  })

  describe('getCategoriesConfig', () => {
    it('fetches categories configuration', async () => {
      const mockConfig = { categories: [{ id: 'cat1', name: 'Category 1', subcategories: [] }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockConfig),
      })

      const result = await api.getCategoriesConfig()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/settings/categories',
        expect.any(Object)
      )
      expect(result).toEqual(mockConfig)
    })
  })

  describe('generateCategories', () => {
    it('sends POST request with company description', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, categories: [] }),
      })

      await api.generateCategories('We are an e-commerce company')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/settings/categories/generate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ company_description: 'We are an e-commerce company' }),
        })
      )
    })
  })

  describe('searchFeedback', () => {
    it('sends search query with parameters', async () => {
      const mockResponse = { count: 5, items: [], entities: {}, query: 'test' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await api.searchFeedback({ q: 'delivery issues', days: 30, limit: 20 })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('q=delivery+issues'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('days=30'),
        expect.any(Object)
      )
    })
  })

  describe('getSimilarFeedback', () => {
    it('fetches similar feedback items', async () => {
      const mockResponse = { source_feedback_id: 'abc', count: 3, items: [] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await api.getSimilarFeedback('abc123', 5)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback/abc123/similar?limit=5',
        expect.any(Object)
      )
    })
  })

  describe('getIntegrationStatus', () => {
    it('fetches integration status', async () => {
      const mockStatus = { webscraper: { configured: true, credentials_set: ['api_key'] } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockStatus),
      })

      const result = await api.getIntegrationStatus()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/integrations/status',
        expect.any(Object)
      )
      expect(result).toEqual(mockStatus)
    })
  })

  describe('updateIntegrationCredentials', () => {
    it('sends PUT request with credentials', async () => {
      const credentials = { api_key: 'test-key', api_secret: 'test-secret' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'Updated' }),
      })

      await api.updateIntegrationCredentials('webscraper', credentials)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/integrations/webscraper/credentials',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(credentials),
        })
      )
    })
  })

  describe('testIntegration', () => {
    it('sends POST request to test integration', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'Connection successful' }),
      })

      await api.testIntegration('webscraper')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/integrations/webscraper/test',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  describe('getS3ImportSources', () => {
    it('fetches S3 import sources', async () => {
      const mockResponse = { sources: [{ name: 'default', display_name: 'Default' }], bucket: 'test-bucket' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.getS3ImportSources()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/s3-import/sources',
        expect.any(Object)
      )
      expect(result).toEqual(mockResponse)
    })
  })

  describe('deleteS3ImportFile', () => {
    it('sends DELETE request for file', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await api.deleteS3ImportFile('default/file.json')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/s3-import/file/'),
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('getPersonas', () => {
    it('fetches personas with days parameter', async () => {
      const mockResponse = { period_days: 7, personas: { 'Power User': 50, 'Casual User': 30 } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.getPersonas({ days: 7 })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/personas?days=7',
        expect.any(Object)
      )
      expect(result).toEqual(mockResponse)
    })

    it('includes source filter when provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ period_days: 7, personas: {} }),
      })

      await api.getPersonas({ days: 7 }, 'webscraper')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/personas?days=7&source=webscraper',
        expect.any(Object)
      )
    })
  })

  describe('getEntities', () => {
    it('fetches entities with parameters', async () => {
      const mockResponse = { entities: { keywords: [], categories: [], issues: [] } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await api.getEntities({ days: 30, limit: 10, source: 'webscraper' })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('days=30'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=10'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('source=webscraper'),
        expect.any(Object)
      )
    })
  })

  describe('getSourcesStatus', () => {
    it('fetches source schedule status', async () => {
      const mockResponse = { sources: { webscraper: { enabled: true, schedule: 'rate(5 minutes)' } } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.getSourcesStatus()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/sources/status',
        expect.any(Object)
      )
      expect(result).toEqual(mockResponse)
    })
  })

  describe('enableSource', () => {
    it('sends PUT request to enable source', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, source: 'webscraper', enabled: true }),
      })

      await api.enableSource('webscraper')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/sources/webscraper/enable',
        expect.objectContaining({ method: 'PUT' })
      )
    })
  })

  describe('disableSource', () => {
    it('sends PUT request to disable source', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, source: 'webscraper', enabled: false }),
      })

      await api.disableSource('webscraper')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/sources/webscraper/disable',
        expect.objectContaining({ method: 'PUT' })
      )
    })
  })

  describe('saveCategoriesConfig', () => {
    it('sends PUT request with categories config', async () => {
      const config = { categories: [{ id: 'cat1', name: 'Category 1', subcategories: [] }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'Saved' }),
      })

      await api.saveCategoriesConfig(config)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/settings/categories',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(config),
        })
      )
    })
  })

  describe('getScraperTemplates', () => {
    it('fetches scraper templates', async () => {
      const mockTemplates = { templates: [{ id: 't1', name: 'Template 1' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockTemplates),
      })

      const result = await api.getScraperTemplates()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/templates',
        expect.any(Object)
      )
      expect(result).toEqual(mockTemplates)
    })
  })

  describe('analyzeUrlForSelectors', () => {
    it('sends POST request with URL to analyze', async () => {
      const mockResponse = { success: true, selectors: { container_selector: '.review' } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await api.analyzeUrlForSelectors('https://example.com/reviews')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/analyze-url',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ url: 'https://example.com/reviews' }),
        })
      )
    })
  })

  describe('runScraper', () => {
    it('sends POST request to run scraper', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, execution_id: 'exec-1', status: 'running' }),
      })

      await api.runScraper('scraper-123')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/scraper-123/run',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  describe('getScraperStatus', () => {
    it('fetches scraper status', async () => {
      const mockStatus = { scraper_id: 's1', status: 'completed', pages_scraped: 5, items_found: 50 }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockStatus),
      })

      const result = await api.getScraperStatus('s1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/s1/status',
        expect.any(Object)
      )
      expect(result).toEqual(mockStatus)
    })
  })

  describe('getScraperRuns', () => {
    it('fetches scraper run history', async () => {
      const mockRuns = { runs: [{ sk: 'run-1', status: 'completed' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockRuns),
      })

      const result = await api.getScraperRuns('s1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/s1/runs',
        expect.any(Object)
      )
      expect(result).toEqual(mockRuns)
    })
  })

  describe('startManualImportParse', () => {
    it('sends POST request with source URL and raw text', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, job_id: 'job-1' }),
      })

      await api.startManualImportParse('https://example.com', 'Review text here')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/manual/parse',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ source_url: 'https://example.com', raw_text: 'Review text here' }),
        })
      )
    })
  })

  describe('getManualImportStatus', () => {
    it('fetches manual import job status', async () => {
      const mockStatus = { status: 'completed', reviews: [{ text: 'Review 1' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockStatus),
      })

      const result = await api.getManualImportStatus('job-1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/manual/parse/job-1',
        expect.any(Object)
      )
      expect(result).toEqual(mockStatus)
    })
  })

  describe('confirmManualImport', () => {
    it('sends POST request with job ID and reviews', async () => {
      const reviews = [{ text: 'Review 1', rating: 5, author: null, date: null, title: null }]
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, imported_count: 1 }),
      })

      await api.confirmManualImport('job-1', reviews)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/manual/confirm',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ job_id: 'job-1', reviews }),
        })
      )
    })
  })

  describe('getFeedbackForms', () => {
    it('fetches all feedback forms', async () => {
      const mockForms = { success: true, forms: [{ form_id: 'f1', name: 'Form 1' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockForms),
      })

      const result = await api.getFeedbackForms()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback-forms',
        expect.any(Object)
      )
      expect(result).toEqual(mockForms)
    })
  })

  describe('createFeedbackForm', () => {
    it('sends POST request with form data', async () => {
      const form = { name: 'New Form', enabled: true }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, form: { ...form, form_id: 'f1' } }),
      })

      await api.createFeedbackForm(form as any)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback-forms',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(form),
        })
      )
    })
  })

  describe('updateFeedbackForm', () => {
    it('sends PUT request with form updates', async () => {
      const updates = { name: 'Updated Form' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, form: { form_id: 'f1', ...updates } }),
      })

      await api.updateFeedbackForm('f1', updates)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback-forms/f1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(updates),
        })
      )
    })
  })

  describe('deleteFeedbackForm', () => {
    it('sends DELETE request for form', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await api.deleteFeedbackForm('f1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback-forms/f1',
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('updateUserGroup', () => {
    it('sends PUT request with new group', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'Updated' }),
      })

      await api.updateUserGroup('user1', 'admins')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/users/user1/group',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ group: 'admins' }),
        })
      )
    })
  })

  describe('resetUserPassword', () => {
    it('sends POST request to reset password', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'Password reset' }),
      })

      await api.resetUserPassword('user1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/users/user1/reset-password',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  describe('enableUser', () => {
    it('sends PUT request to enable user', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'User enabled' }),
      })

      await api.enableUser('user1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/users/user1/enable',
        expect.objectContaining({ method: 'PUT' })
      )
    })
  })

  describe('disableUser', () => {
    it('sends PUT request to disable user', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'User disabled' }),
      })

      await api.disableUser('user1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/users/user1/disable',
        expect.objectContaining({ method: 'PUT' })
      )
    })
  })

  describe('deleteUser', () => {
    it('sends DELETE request for user', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'User deleted' }),
      })

      await api.deleteUser('user1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/users/user1',
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('getPrioritizationScores', () => {
    it('fetches prioritization scores', async () => {
      const mockScores = { scores: { issue1: { impact: 5, effort: 3 } } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScores),
      })

      const result = await api.getPrioritizationScores()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/prioritization',
        expect.any(Object)
      )
      expect(result).toEqual(mockScores)
    })

    it('passes through the aggregates the endpoint returns beside scores', async () => {
      // `aggregates` exists so a later frontend change can show what every
      // reviewer together said. Type-erasing it would leave the next author
      // reaching for a cast, with nothing saying the field is already on the wire.
      const response = {
        scores: {
          doc1: {
            document_id: 'doc1', impact: 5, time_to_market: 3, confidence: 2, strategic_fit: 4, notes: '',
          },
        },
        aggregates: {
          doc1: {
            impact: 4, time_to_market: 3, confidence: 2, strategic_fit: 4, reviewer_count: 2, score_spread: 0.4,
          },
        },
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      })

      const result = await api.getPrioritizationScores()

      expect(result.aggregates?.doc1.reviewer_count).toBe(2)
      expect(result.aggregates?.doc1.score_spread).toBe(0.4)
    })

    it('still resolves when an older deployment omits aggregates', async () => {
      // Which is why the field is optional in the type rather than required.
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ scores: {} }),
      })

      const result = await api.getPrioritizationScores()

      expect(result.aggregates).toBeUndefined()
    })
  })

  describe('savePrioritizationScores', () => {
    it('is gone, because a whole-map PUT overwrote every reviewer', () => {
      // Scores are per-reviewer ballots now, so one caller's map is not
      // everyone's scores. The endpoint refuses PUT, so a client function for it
      // could only ever produce a 400.
      expect('savePrioritizationScores' in api).toBe(false)
    })
  })

  describe('patchPrioritizationScores', () => {
    it('sends PATCH request with only changed scores', async () => {
      const changedScores = { doc1: { document_id: 'doc1', impact: 4, time_to_market: 2, confidence: 3, strategic_fit: 4, notes: 'test' } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, updated_count: 1 }),
      })

      await api.patchPrioritizationScores(changedScores as any)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/prioritization',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ scores: changedScores }),
        })
      )
    })
  })

  describe('createS3ImportSource', () => {
    it('sends POST request with source name', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, source: { name: 'new-source' } }),
      })

      await api.createS3ImportSource('new-source')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/s3-import/sources',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'new-source' }),
        })
      )
    })
  })

  describe('getS3ImportFiles', () => {
    it('fetches files with source filter', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ files: [], bucket: 'test-bucket' }),
      })

      await api.getS3ImportFiles({ source: 'default', include_processed: true })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('source=default'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('include_processed=true'),
        expect.any(Object)
      )
    })
  })

  describe('getS3UploadUrl', () => {
    it('sends POST request for presigned URL', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, upload_url: 'https://s3.example.com/upload' }),
      })

      await api.getS3UploadUrl('file.json', 'default', 'application/json')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/s3-import/upload-url',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ filename: 'file.json', source: 'default', content_type: 'application/json' }),
        })
      )
    })
  })

  describe('getDataExplorerBuckets', () => {
    it('fetches available buckets', async () => {
      const mockBuckets = { buckets: [{ id: 'raw', name: 'voc-raw-data', label: 'Raw Data' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockBuckets),
      })

      const result = await api.getDataExplorerBuckets()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/data-explorer/buckets',
        expect.any(Object)
      )
      expect(result).toEqual(mockBuckets)
    })
  })

  describe('getDataExplorerS3', () => {
    it('fetches S3 objects with prefix and bucket', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ objects: [], bucket: 'test', prefix: 'raw/' }),
      })

      await api.getDataExplorerS3('raw/', 'test-bucket')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('prefix=raw'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('bucket=test-bucket'),
        expect.any(Object)
      )
    })
  })

  describe('getDataExplorerS3Preview', () => {
    it('fetches file preview', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: { test: 'data' }, size: 100 }),
      })

      await api.getDataExplorerS3Preview('raw/file.json', 'test-bucket')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('key=raw'),
        expect.any(Object)
      )
    })
  })

  describe('saveDataExplorerS3', () => {
    it('sends PUT request with content', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await api.saveDataExplorerS3('raw/file.json', '{"test": "data"}', true, 'test-bucket')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/data-explorer/s3',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ key: 'raw/file.json', content: '{"test": "data"}', sync_to_dynamo: true, bucket: 'test-bucket' }),
        })
      )
    })
  })

  describe('deleteDataExplorerS3', () => {
    it('sends DELETE request for S3 file', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await api.deleteDataExplorerS3('raw/file.json', 'test-bucket')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('key=raw'),
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('saveDataExplorerFeedback', () => {
    it('sends PUT request with feedback data', async () => {
      const data = { text: 'Updated feedback' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await api.saveDataExplorerFeedback('fb-1', data as any, true)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/data-explorer/feedback',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ feedback_id: 'fb-1', data, sync_to_s3: true }),
        })
      )
    })
  })

  describe('deleteDataExplorerFeedback', () => {
    it('sends DELETE request for feedback', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await api.deleteDataExplorerFeedback('fb-1')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('feedback_id=fb-1'),
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('getValidationLogs', () => {
    it('fetches validation logs with default parameters', async () => {
      const mockResponse = { logs: [], count: 0, days: 7 }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.getValidationLogs()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/logs/validation?',
        expect.any(Object)
      )
      expect(result).toEqual(mockResponse)
    })

    it('includes source and days parameters when provided', async () => {
      const mockResponse = { logs: [{ source_platform: 'webscraper', message_id: 'msg-1' }], count: 1, days: 7 }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await api.getValidationLogs({ source: 'webscraper', days: 7, limit: 50 })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('source=webscraper'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('days=7'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=50'),
        expect.any(Object)
      )
    })
  })

  describe('getProcessingLogs', () => {
    it('fetches processing logs with parameters', async () => {
      const mockResponse = { logs: [{ error_type: 'BedrockError', error_message: 'Failed' }], count: 1, days: 7 }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.getProcessingLogs({ days: 7 })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/logs/processing'),
        expect.any(Object)
      )
      expect(result).toEqual(mockResponse)
    })
  })

  describe('getLogsSummary', () => {
    it('fetches logs summary with days parameter', async () => {
      const mockResponse = {
        summary: {
          validation_failures: { webscraper: 5 },
          processing_errors: { manual_import: 2 },
          total_validation_failures: 5,
          total_processing_errors: 2,
        },
        days: 7,
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.getLogsSummary(7)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/logs/summary?days=7',
        expect.any(Object)
      )
      expect(result).toEqual(mockResponse)
    })

    it('uses default days when not provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ summary: {}, days: 7 }),
      })

      await api.getLogsSummary()

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/logs/summary'),
        expect.any(Object)
      )
    })
  })

  describe('getScraperLogs', () => {
    it('fetches scraper logs by scraper ID', async () => {
      const mockResponse = {
        scraper_id: 'scraper-123',
        logs: [{ run_id: 'run-1', status: 'completed', pages_scraped: 10 }],
        count: 1,
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await api.getScraperLogs('scraper-123', { days: 7, limit: 10 })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/logs/scraper/scraper-123'),
        expect.any(Object)
      )
      expect(result).toEqual(mockResponse)
    })
  })

  describe('clearValidationLogs', () => {
    it('sends DELETE request to clear validation logs for source', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, deleted: 5 }),
      })

      const result = await api.clearValidationLogs('webscraper')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/logs/validation/webscraper',
        expect.objectContaining({ method: 'DELETE' })
      )
      expect(result).toEqual({ success: true, deleted: 5 })
    })
  })
})

describe('getDaysFromRange', () => {
  it('returns 1 for 24h range', () => {
    expect(getDaysFromRange('24h')).toBe(1)
  })

  it('returns 2 for 48h range', () => {
    expect(getDaysFromRange('48h')).toBe(2)
  })

  it('returns 7 for 7d range', () => {
    expect(getDaysFromRange('7d')).toBe(7)
  })

  it('returns 30 for 30d range', () => {
    expect(getDaysFromRange('30d')).toBe(30)
  })

  it('returns 7 for unknown range', () => {
    expect(getDaysFromRange('unknown')).toBe(7)
  })

  it('returns the custom lookback in days', () => {
    expect(getDaysFromRange('custom', 10)).toBe(10)
  })

  it('returns default when custom days is null', () => {
    expect(getDaysFromRange('custom', null)).toBe(7)
  })

  it('returns default when custom days is invalid', () => {
    expect(getDaysFromRange('custom', 0)).toBe(7)
  })
})

describe('getDateRangeParams', () => {
  it('returns days for standard ranges', () => {
    expect(getDateRangeParams('7d')).toEqual({ days: 7 })
    expect(getDateRangeParams('30d')).toEqual({ days: 30 })
  })

  it('returns the custom lookback as days', () => {
    expect(getDateRangeParams('custom', 21)).toEqual({ days: 21 })
  })

  it('returns default days when custom days is null', () => {
    expect(getDateRangeParams('custom', null)).toEqual({ days: 7 })
  })

  it('caps the "all" range at ALL_TIME_DAYS', () => {
    expect(getDateRangeParams('all')).toEqual({ days: ALL_TIME_DAYS })
    // The cap must not exceed the backend validate_days max (365) to avoid
    // silent clamping server-side.
    expect(ALL_TIME_DAYS).toBeLessThanOrEqual(365)
  })

  it('only ever carries a days param (no calendar window)', () => {
    const params = getDateRangeParams('custom', 30)
    expect(params).toEqual({ days: 30 })
    expect(params).not.toHaveProperty('start_date')
    expect(params).not.toHaveProperty('end_date')
  })

  it('omits date_basis for the default imported basis', () => {
    // Keeping the params shape unchanged for 'imported' preserves existing
    // request URLs and TanStack Query cache keys.
    expect(getDateRangeParams('7d', null, 'imported')).toEqual({ days: 7 })
    expect(getDateRangeParams('7d')).toEqual({ days: 7 })
  })

  it('includes date_basis=review when filtering by review date', () => {
    expect(getDateRangeParams('30d', null, 'review')).toEqual({
      days: 30,
      date_basis: 'review',
    })
  })

  it('combines the custom lookback with the review basis', () => {
    expect(getDateRangeParams('custom', 14, 'review')).toEqual({
      days: 14,
      date_basis: 'review',
    })
  })
})

describe('searchFeedback trims the query at the boundary', () => {
  // `/feedback/search` trims `q` before applying its minimum and refuses a
  // present-but-too-short term with a 400. Trimming here means the string that
  // is SENT is the string the route measures, whatever a caller passed in.
  //
  // Asserted on the REQUEST URL, not on the source text of client.ts. Matching a
  // literal like `q: params.q.trim()` would pin characters rather than behaviour,
  // and break on a reformat or an extracted local with nothing having changed.
  beforeEach(() => {
    ;(useConfigStore.getState as ReturnType<typeof vi.fn>).mockReturnValue(DEFAULT_STORE_STATE)
    ;(authService.refreshSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const okOnce = (body: unknown) =>
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(body),
    })

  const requestedUrl = () =>
    String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])

  it('sends the trimmed term when the caller passes surrounding whitespace', async () => {
    okOnce({ count: 0, items: [], entities: {}, query: 'delivery' })

    await api.searchFeedback({ q: '  delivery  ' })

    expect(requestedUrl()).toContain('q=delivery')
  })

  it('preserves interior spaces, which are part of the term', async () => {
    okOnce({ count: 0, items: [], entities: {}, query: 'slow delivery' })

    await api.searchFeedback({ q: '  slow delivery  ' })

    // URLSearchParams encodes the space; what matters is that it survives.
    expect(decodeURIComponent(requestedUrl().replace(/\+/g, ' '))).toContain('q=slow delivery')
  })

  it('surfaces the truncation flag the route reports', async () => {
    okOnce({ count: 1, items: [{ feedback_id: '1' }], entities: {}, query: 'x', is_partial_window: true })

    const result = await api.searchFeedback({ q: 'delivery' })

    expect(result.is_partial_window).toBe(true)
  })
})
