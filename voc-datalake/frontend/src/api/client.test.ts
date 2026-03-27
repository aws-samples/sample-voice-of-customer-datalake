/**
 * @fileoverview Tests for API client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock stores and auth before importing client
vi.mock('../store/configStore', () => ({
  useConfigStore: {
    getState: vi.fn(() => ({
      config: { 
        apiEndpoint: 'https://api.example.com'
      },
    })),
  },
}))

vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(() => true),
    getIdToken: vi.fn(() => 'mock-id-token'),
    getAccessToken: vi.fn(() => Promise.resolve('mock-access-token')),
    refreshSession: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn(),
  },
}))

import { api } from './client'
import { getDaysFromRange } from './baseUrl'
import { authService } from '../services/auth'
import { scrapersApi } from './scrapersApi'
import { projectsApi } from './projectsApi'
import type { ScraperConfig } from './types'

describe('API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getFeedback', () => {
    it('fetches feedback with correct query parameters', async () => {
      const mockItems = [
        {
          feedback_id: '1',
          source_id: 'src-1',
          source_platform: 'webscraper',
          source_channel: 'web',
          brand_name: 'TestBrand',
          source_created_at: '2025-01-01T00:00:00Z',
          processed_at: '2025-01-01T00:01:00Z',
          original_text: 'Great product',
          original_language: 'en',
          category: 'general',
          journey_stage: 'post_purchase',
          sentiment_label: 'positive',
          sentiment_score: 0.9,
          urgency: 'low',
          impact_area: 'product',
        },
        {
          feedback_id: '2',
          source_id: 'src-2',
          source_platform: 'webscraper',
          source_channel: 'web',
          brand_name: 'TestBrand',
          source_created_at: '2025-01-02T00:00:00Z',
          processed_at: '2025-01-02T00:01:00Z',
          original_text: 'Needs improvement',
          original_language: 'en',
          category: 'general',
          journey_stage: 'post_purchase',
          sentiment_label: 'negative',
          sentiment_score: -0.5,
          urgency: 'medium',
          impact_area: 'product',
        },
      ]
      const mockResponse = { count: 2, items: mockItems }
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
      expect(result).toStrictEqual(mockResponse)
    })

    it('throws error on non-ok response', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

      await expect(api.getFeedback({ days: 7 })).rejects.toThrow('API Error: 500')
    })

    it('includes days, source, and category filter parameters', async () => {
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
    })

    it('includes sentiment and limit filter parameters', async () => {
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

      expect(authService.refreshSession).toHaveBeenCalledWith()
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('signs out and redirects when refresh fails', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: false, status: 401 })

      const originalLocation = window.location
      Object.defineProperty(window, 'location', {
        value: { href: '' } as unknown as Location,
        writable: true,
      })

      await expect(api.getFeedback({ days: 7 })).rejects.toThrow('Session expired')
      expect(authService.signOut).toHaveBeenCalledWith()

      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      })
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
      expect(result).toStrictEqual(mockFeedback)
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
      const mockSummary = {
        period_days: 30,
        total_feedback: 100,
        avg_sentiment: 0.5,
        urgent_count: 5,
        daily_totals: [{ date: '2025-01-01', count: 10 }],
        daily_sentiment: [{ date: '2025-01-01', avg_sentiment: 0.5, count: 10 }],
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSummary),
      })

      const result = await api.getSummary(30)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/summary?days=30',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockSummary)
    })

    it('includes source filter when provided', async () => {
      const mockSummary = {
        period_days: 7,
        total_feedback: 0,
        avg_sentiment: 0,
        urgent_count: 0,
        daily_totals: [],
        daily_sentiment: [],
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSummary),
      })

      await api.getSummary(7, 'webscraper')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/summary?days=7&source=webscraper',
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

      const result = await api.getSentiment(7)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/sentiment?days=7',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockSentiment)
    })
  })

  describe('getCategories', () => {
    it('fetches category breakdown', async () => {
      const mockCategories = { categories: { delivery: 50, quality: 30 } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCategories),
      })

      const result = await api.getCategories(14)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/categories?days=14',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockCategories)
    })
  })

  describe('getSources', () => {
    it('fetches source breakdown', async () => {
      const mockSources = { sources: { webscraper: 100, manual_import: 50 } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSources),
      })

      const result = await api.getSources(7)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/sources?days=7',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockSources)
    })
  })

  describe('getScrapers', () => {
    it('fetches scraper configurations', async () => {
      const mockScrapers = { scrapers: [{ id: 's1', name: 'Test Scraper' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScrapers),
      })

      const result = await scrapersApi.getScrapers()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockScrapers)
    })
  })

  describe('saveScraper', () => {
    it('sends POST request with scraper config', async () => {
      const scraper: Partial<ScraperConfig> = { id: 's1', name: 'Test', enabled: true }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, scraper }),
      })

      await scrapersApi.saveScraper(scraper as ScraperConfig)

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

      await scrapersApi.deleteScraper('scraper-123')

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

      const result = await projectsApi.getProjects()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockProjects)
    })
  })

  describe('createProject', () => {
    it('sends POST request with project data', async () => {
      const projectData = { name: 'New Project', description: 'Test' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, project: { ...projectData, id: 'p1' } }),
      })

      await projectsApi.createProject(projectData)

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
      expect(result).toStrictEqual(mockUsers)
    })
  })

  describe('createUser', () => {
    it('sends POST request with user data', async () => {
      const userData = { username: 'newuser', email: 'new@example.com', name: 'New User', group: 'users' as const }
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
      expect(result).toStrictEqual(mockSettings)
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
      expect(result).toStrictEqual(mockConfig)
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
      expect(result).toStrictEqual(mockStatus)
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

  describe('getIntegrationCredentials', () => {
    it('fetches credentials with keys as comma-separated query param', async () => {
      const mockCredentials = { app_name: 'my-app', package_name: 'com.example.app' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCredentials),
      })

      const result = await api.getIntegrationCredentials('app_reviews_android', ['app_name', 'package_name'])

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/integrations/app_reviews_android/credentials?keys=app_name,package_name',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'mock-id-token',
          }),
        })
      )
      expect(result).toStrictEqual(mockCredentials)
    })

    it('handles single key', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ app_id: '585629514' }),
      })

      const result = await api.getIntegrationCredentials('app_reviews_ios', ['app_id'])

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/integrations/app_reviews_ios/credentials?keys=app_id',
        expect.any(Object)
      )
      expect(result).toStrictEqual({ app_id: '585629514' })
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

  it('calculates days from custom date range', () => {
    const customRange = { start: '2025-01-01', end: '2025-01-10' }
    expect(getDaysFromRange('custom', customRange)).toBe(10)
  })

  it('returns default when custom range is null', () => {
    expect(getDaysFromRange('custom', null)).toBe(7)
  })
})
