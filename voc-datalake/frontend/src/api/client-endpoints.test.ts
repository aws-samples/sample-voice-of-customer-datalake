/**
 * @fileoverview Tests for domain-specific API client endpoints.
 * Split from client.test.ts to stay within max-lines limit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FeedbackFormConfig, FeedbackForm, PrioritizationScore } from './types'

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
import { scrapersApi } from './scrapersApi'
import { feedbackFormsApi } from './feedbackFormsApi'
import { dataExplorerApi } from './dataExplorerApi'

describe('API Client - Domain Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response())
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  describe('getFeedbackFormConfig', () => {
    it('fetches feedback form configuration', async () => {
      const mockConfig = { success: true, config: { enabled: true, title: 'Feedback' } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockConfig),
      })

      const result = await feedbackFormsApi.getFeedbackFormConfig()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback-form/config',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockConfig)
    })
  })

  describe('getS3ImportSources', () => {
    it('fetches S3 import sources', async () => {
      const mockResponse = { sources: [{ name: 'default', display_name: 'Default' }], bucket: 'test-bucket' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await dataExplorerApi.getS3ImportSources()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/s3-import/sources',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockResponse)
    })
  })

  describe('deleteS3ImportFile', () => {
    it('sends DELETE request for file', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await dataExplorerApi.deleteS3ImportFile('default/file.json')

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
      expect(result).toStrictEqual(mockResponse)
    })

    it('includes source filter when provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ period_days: 7, personas: {} }),
      })

      await api.getPersonas(7, 'webscraper')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/metrics/personas?days=7&source=webscraper',
        expect.any(Object)
      )
    })
  })

  describe('getEntities', () => {
    it('fetches entities with days param', async () => {
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
    })

    it('fetches entities with limit and source params', async () => {
      const mockResponse = { entities: { keywords: [], categories: [], issues: [] } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await api.getEntities({ days: 30, limit: 10, source: 'webscraper' })

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
      expect(result).toStrictEqual(mockResponse)
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

      const result = await scrapersApi.getScraperTemplates()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/templates',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockTemplates)
    })
  })

  describe('analyzeUrlForSelectors', () => {
    it('sends POST request with URL to analyze', async () => {
      const mockResponse = { success: true, selectors: { container_selector: '.review' } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await scrapersApi.analyzeUrlForSelectors('https://example.com/reviews')

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

      await scrapersApi.runScraper('scraper-123')

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

      const result = await scrapersApi.getScraperStatus('s1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/s1/status',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockStatus)
    })
  })

  describe('getScraperRuns', () => {
    it('fetches scraper run history', async () => {
      const mockRuns = { runs: [{ sk: 'run-1', status: 'completed' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockRuns),
      })

      const result = await scrapersApi.getScraperRuns('s1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/s1/runs',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockRuns)
    })
  })

  describe('startManualImportParse', () => {
    it('sends POST request with source URL and raw text', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, job_id: 'job-1' }),
      })

      await scrapersApi.startManualImportParse('https://example.com', 'Review text here')

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

      const result = await scrapersApi.getManualImportStatus('job-1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/scrapers/manual/parse/job-1',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockStatus)
    })
  })

  describe('confirmManualImport', () => {
    it('sends POST request with job ID and reviews', async () => {
      const reviews = [{ text: 'Review 1', rating: 5, author: null, date: null, title: null }]
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, imported_count: 1 }),
      })

      await scrapersApi.confirmManualImport('job-1', reviews)

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
      const config: Partial<FeedbackFormConfig> = { enabled: true, title: 'Feedback', description: 'Share your thoughts' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, message: 'Saved' }),
      })

      await feedbackFormsApi.saveFeedbackFormConfig(config as FeedbackFormConfig)

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

      await feedbackFormsApi.submitFeedbackForm(data)

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

      const result = await feedbackFormsApi.getFeedbackForms()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/feedback-forms',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockForms)
    })
  })

  describe('createFeedbackForm', () => {
    it('sends POST request with form data', async () => {
      const form: Partial<FeedbackForm> = { name: 'New Form', enabled: true }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, form: { ...form, form_id: 'f1' } }),
      })

      await feedbackFormsApi.createFeedbackForm(form as FeedbackForm)

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

      await feedbackFormsApi.updateFeedbackForm('f1', updates)

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

      await feedbackFormsApi.deleteFeedbackForm('f1')

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
      expect(result).toStrictEqual(mockScores)
    })
  })

  describe('patchPrioritizationScores', () => {
    it('sends PATCH request with only changed scores', async () => {
      const changedScores: Record<string, PrioritizationScore> = {
        doc1: { document_id: 'doc1', impact: 4, time_to_market: 2, confidence: 3, strategic_fit: 4, notes: 'test' },
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, updated_count: 1 }),
      })

      await api.patchPrioritizationScores(changedScores)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/prioritization',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ scores: changedScores }),
        })
      )
    })
  })

})
