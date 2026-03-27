/**
 * @fileoverview Tests for storage and logging API client endpoints.
 * Covers S3 import, data explorer, and logs APIs.
 * Split from client.test.ts to stay within max-lines limit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FeedbackItem } from './types'

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
import { dataExplorerApi } from './dataExplorerApi'

describe('API Client - Storage & Logs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('createS3ImportSource', () => {
    it('sends POST request with source name', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, source: { name: 'new-source' } }),
      })

      await dataExplorerApi.createS3ImportSource('new-source')

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

      await dataExplorerApi.getS3ImportFiles({ source: 'default', include_processed: true })

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

      await dataExplorerApi.getS3UploadUrl('file.json', 'default', 'application/json')

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

      const result = await dataExplorerApi.getDataExplorerBuckets()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/data-explorer/buckets',
        expect.any(Object)
      )
      expect(result).toStrictEqual(mockBuckets)
    })
  })

  describe('getDataExplorerS3', () => {
    it('fetches S3 objects with prefix and bucket', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ objects: [], bucket: 'test', prefix: 'raw/' }),
      })

      await dataExplorerApi.getDataExplorerS3('raw/', 'test-bucket')

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

      await dataExplorerApi.getDataExplorerS3Preview('raw/file.json', 'test-bucket')

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

      await dataExplorerApi.saveDataExplorerS3('raw/file.json', '{"test": "data"}', true, 'test-bucket')

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

      await dataExplorerApi.deleteDataExplorerS3('raw/file.json', 'test-bucket')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('key=raw'),
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('saveDataExplorerFeedback', () => {
    it('sends PUT request with feedback data', async () => {
      const data: Partial<FeedbackItem> = { original_text: 'Updated feedback' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await dataExplorerApi.saveDataExplorerFeedback('fb-1', data as FeedbackItem, true)

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

      await dataExplorerApi.deleteDataExplorerFeedback('fb-1')

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
      expect(result).toStrictEqual(mockResponse)
    })

    it('includes source and days parameters when provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ logs: [], count: 1, days: 7 }),
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
    })

    it('includes limit parameter when provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ logs: [], count: 1, days: 7 }),
      })

      await api.getValidationLogs({ source: 'webscraper', days: 7, limit: 50 })

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
      expect(result).toStrictEqual(mockResponse)
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
      expect(result).toStrictEqual(mockResponse)
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
      expect(result).toStrictEqual(mockResponse)
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
      expect(result).toStrictEqual({ success: true, deleted: 5 })
    })
  })
})
