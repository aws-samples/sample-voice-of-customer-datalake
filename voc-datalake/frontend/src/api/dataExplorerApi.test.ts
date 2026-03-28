/**
 * @fileoverview Tests for Data Explorer API client.
 *
 * Validates that the frontend API types match the actual backend response formats.
 * These tests prevent regressions where the frontend expects a different response
 * structure than what the backend returns.
 *
 * Bug context:
 * - S3 browser showed "No files found" because frontend expected {folders, files}
 *   but backend returned {objects} with isFolder flag
 * - Buckets dropdown used wrong field (name instead of id) for bucket selection
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetchApi to return controlled responses
const mockFetchApi = vi.fn()
vi.mock('./client', () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
  buildSearchParams: (params: Record<string, string | number | boolean | undefined | null>) => {
    const sp = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value != null) sp.set(key, String(value))
    }
    return sp
  },
}))

import { dataExplorerApi } from './dataExplorerApi'

const s3BackendResponse = {
  objects: [
    { key: 'raw', size: 0, lastModified: '', isFolder: true },
    { key: 'test.json', fullKey: 'raw/test.json', size: 512, lastModified: '2025-03-01T00:00:00Z', isFolder: false },
  ],
  bucket: 'voc-raw-data-123456-us-east-1',
  bucketId: 'raw-data',
  bucketLabel: 'VoC Raw Data',
  prefix: '',
}

describe('dataExplorerApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getDataExplorerS3', () => {
    it('returns objects array matching backend format', async () => {
      mockFetchApi.mockResolvedValue(s3BackendResponse)

      const result = await dataExplorerApi.getDataExplorerS3()

      expect(result.objects).toHaveLength(2)
      expect(result.objects[0].isFolder).toBe(true)
      expect(result.objects[0].key).toBe('raw')
      expect(result.objects[1].isFolder).toBe(false)
    })

    it('includes bucket metadata and file details in response', async () => {
      mockFetchApi.mockResolvedValue(s3BackendResponse)

      const result = await dataExplorerApi.getDataExplorerS3()

      expect(result.objects[1].fullKey).toBe('raw/test.json')
      expect(result.bucket).toBe('voc-raw-data-123456-us-east-1')
      expect(result.bucketId).toBe('raw-data')
    })

    it('passes prefix and bucket as query params', async () => {
      mockFetchApi.mockResolvedValue({ objects: [], bucket: '', bucketId: '', prefix: '' })

      await dataExplorerApi.getDataExplorerS3('raw/2025/03', 'raw-data')

      expect(mockFetchApi).toHaveBeenCalledWith(
        expect.stringContaining('prefix=raw'),
      )
      expect(mockFetchApi).toHaveBeenCalledWith(
        expect.stringContaining('bucket=raw-data'),
      )
    })

    it('handles empty bucket response', async () => {
      const emptyResponse = {
        objects: [],
        bucket: null,
        bucketId: 'raw-data',
        prefix: '',
        error: 'Bucket not configured',
      }
      mockFetchApi.mockResolvedValue(emptyResponse)

      const result = await dataExplorerApi.getDataExplorerS3()
      expect(result.objects).toStrictEqual([])
    })
  })

  describe('getDataExplorerBuckets', () => {
    it('returns buckets with id, name, label, and description', async () => {
      const backendResponse = {
        buckets: [
          {
            id: 'raw-data',
            name: 'voc-raw-data-123456-us-east-1',
            label: 'VoC Raw Data',
            description: 'Raw feedback data from all sources',
          },
        ],
      }
      mockFetchApi.mockResolvedValue(backendResponse)

      const result = await dataExplorerApi.getDataExplorerBuckets()

      expect(result.buckets).toHaveLength(1)
      expect(result.buckets[0].id).toBe('raw-data')
      expect(result.buckets[0].name).toBe('voc-raw-data-123456-us-east-1')
      expect(result.buckets[0].label).toBe('VoC Raw Data')
    })
  })

  describe('getDataExplorerS3Preview', () => {
    it('returns JSON content for text files', async () => {
      const backendResponse = {
        content: { text: 'Hello', rating: 5 },
        size: 256,
        contentType: 'application/json',
        key: 'raw/test.json',
      }
      mockFetchApi.mockResolvedValue(backendResponse)

      const result = await dataExplorerApi.getDataExplorerS3Preview('raw/test.json')
      expect(result.content).toStrictEqual({ text: 'Hello', rating: 5 })
      expect(result.key).toBe('raw/test.json')
    })
  })
})
