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

import { api, getDaysFromRange, getDateRangeParams } from './client'
import { authService } from '../services/auth'

describe('API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

      const result = await api.getFeedback({ days: 7, source: 'twitter' })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback?days=7&source=twitter',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'mock-id-token',
          }),
        })
      )
      expect(result).toEqual(mockResponse)
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
        source: 'instagram', 
        category: 'delivery', 
        sentiment: 'negative',
        limit: 50 
      })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('days=30'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('source=instagram'),
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

    it('signs out and redirects when refresh fails', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: false, status: 401 })

      const originalLocation = window.location
      Object.defineProperty(window, 'location', {
        value: { href: '' },
        writable: true,
      })

      await expect(api.getFeedback({ days: 7 })).rejects.toThrow('Session expired')
      expect(authService.signOut).toHaveBeenCalled()

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
      expect(result).toEqual(mockFeedback)
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

      const result = await api.getSummary(30)

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

      await api.getSummary(7, 'twitter')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/summary?days=7&source=twitter',
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

      const result = await api.getCategories(14)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/categories?days=14',
        expect.any(Object)
      )
      expect(result).toEqual(mockCategories)
    })
  })

  describe('getSources', () => {
    it('fetches source breakdown', async () => {
      const mockSources = { sources: { twitter: 100, instagram: 50 } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSources),
      })

      const result = await api.getSources(7)

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
      const mockStatus = { trustpilot: { configured: true, credentials_set: ['api_key'] } }
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

      await api.updateIntegrationCredentials('trustpilot', credentials)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/integrations/trustpilot/credentials',
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

      await api.testIntegration('twitter')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/integrations/twitter/test',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  describe('getFeedbackFormConfig', () => {
    it('fetches feedback form configuration', async () => {
      const mockConfig = { success: true, config: { enabled: true, title: 'Feedback' } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockConfig),
      })

      const result = await api.getFeedbackFormConfig()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback-form/config',
        expect.any(Object)
      )
      expect(result).toEqual(mockConfig)
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

      const result = await api.getPersonas(7)

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

      await api.getPersonas(7, 'twitter')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/personas?days=7&source=twitter',
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

      await api.getEntities({ days: 30, limit: 10, source: 'twitter' })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('days=30'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=10'),
        expect.any(Object)
      )
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('source=twitter'),
        expect.any(Object)
      )
    })
  })

  describe('getSourcesStatus', () => {
    it('fetches source schedule status', async () => {
      const mockResponse = { sources: { twitter: { enabled: true, schedule: 'rate(5 minutes)' } } }
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
        json: () => Promise.resolve({ success: true, source: 'twitter', enabled: true }),
      })

      await api.enableSource('twitter')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/sources/twitter/enable',
        expect.objectContaining({ method: 'PUT' })
      )
    })
  })

  describe('disableSource', () => {
    it('sends PUT request to disable source', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, source: 'twitter', enabled: false }),
      })

      await api.disableSource('twitter')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/sources/twitter/disable',
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

  describe('saveFeedbackFormConfig', () => {
    it('sends PUT request with form config', async () => {
      const config = { enabled: true, title: 'Feedback', description: 'Share your thoughts' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'Saved' }),
      })

      await api.saveFeedbackFormConfig(config as any)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback-form/config',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(config),
        })
      )
    })
  })

  describe('submitFeedbackForm', () => {
    it('sends POST request with feedback data', async () => {
      const data = { text: 'Great product!', rating: 5, email: 'test@example.com' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, feedback_id: 'fb-1' }),
      })

      await api.submitFeedbackForm(data)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback-form/submit',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(data),
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
  })

  describe('savePrioritizationScores', () => {
    it('sends PUT request with scores', async () => {
      const scores = { issue1: { impact: 5, effort: 3 } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await api.savePrioritizationScores(scores as any)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/prioritization',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ scores }),
        })
      )
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
      const mockResponse = { logs: [{ source_platform: 'twitter', message_id: 'msg-1' }], count: 1, days: 7 }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await api.getValidationLogs({ source: 'twitter', days: 7, limit: 50 })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('source=twitter'),
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
          validation_failures: { twitter: 5 },
          processing_errors: { trustpilot: 2 },
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

      const result = await api.clearValidationLogs('twitter')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/logs/validation/twitter',
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

  it('calculates days from custom date range', () => {
    const customRange = { start: '2025-01-01', end: '2025-01-10' }
    expect(getDaysFromRange('custom', customRange)).toBe(10)
  })

  it('returns default when custom range is null', () => {
    expect(getDaysFromRange('custom', null)).toBe(7)
  })
})

describe('getDateRangeParams', () => {
  it('returns days for standard ranges', () => {
    expect(getDateRangeParams('7d')).toEqual({ days: 7 })
    expect(getDateRangeParams('30d')).toEqual({ days: 30 })
  })

  it('returns start_date and end_date for custom range', () => {
    const customRange = { start: '2025-01-01', end: '2025-01-31' }
    expect(getDateRangeParams('custom', customRange)).toEqual({
      start_date: '2025-01-01',
      end_date: '2025-01-31',
    })
  })

  it('returns days when custom range is null', () => {
    expect(getDateRangeParams('custom', null)).toEqual({ days: 7 })
  })
})
