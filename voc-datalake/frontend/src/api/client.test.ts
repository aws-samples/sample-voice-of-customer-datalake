/**
 * @fileoverview Tests for API client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock stores and auth before importing client
vi.mock('../store/configStore', () => ({
  useConfigStore: {
    getState: vi.fn(() => ({
      config: { 
        apiEndpoint: 'https://api.example.com',
        artifactBuilderEndpoint: 'https://artifact.example.com'
      },
    })),
  },
}))

vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(() => true),
    getIdToken: vi.fn(() => 'mock-id-token'),
    getAccessToken: vi.fn(() => Promise.resolve('mock-access-token')),
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  },
}))

import { api } from './client'

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
})
