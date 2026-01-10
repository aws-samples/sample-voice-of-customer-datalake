/**
 * @fileoverview Tests for artifactApi.ts
 * @module api/artifactApi.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock stores and services before importing
const mockGetState = vi.fn()
vi.mock('../store/configStore', () => ({
  useConfigStore: { getState: () => mockGetState() },
}))

vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(() => true),
    getIdToken: vi.fn(() => 'mock-id-token'),
  },
}))

import { artifactApi } from './artifactApi'

describe('artifactApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetState.mockReturnValue({ config: { artifactBuilderEndpoint: 'https://artifact.example.com' } })
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getTemplates', () => {
    it('returns templates and styles on success', async () => {
      const mockResponse = {
        templates: [{ id: 'react-vite', name: 'React + Vite' }],
        styles: [{ id: 'minimal', name: 'Minimal' }],
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await artifactApi.getTemplates()

      expect(result).toEqual(mockResponse)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://artifact.example.com/templates',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'mock-id-token',
          }),
        })
      )
    })

    it('throws error when endpoint not configured', async () => {
      mockGetState.mockReturnValue({ config: { artifactBuilderEndpoint: '' } })

      await expect(artifactApi.getTemplates()).rejects.toThrow('Artifact Builder endpoint not configured')
    })

    it('throws error on non-ok response', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

      await expect(artifactApi.getTemplates()).rejects.toThrow('Artifact Builder API Error: 500')
    })
  })

  describe('createJob', () => {
    it('creates job with correct payload', async () => {
      const mockResponse = { job_id: 'job-123' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await artifactApi.createJob({
        prompt: 'Build a landing page',
        project_type: 'react-vite',
        style: 'minimal',
        include_mock_data: true,
        pages: ['Home', 'About'],
      })

      expect(result).toEqual(mockResponse)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://artifact.example.com/jobs',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            prompt: 'Build a landing page',
            project_type: 'react-vite',
            style: 'minimal',
            include_mock_data: true,
            pages: ['Home', 'About'],
          }),
        })
      )
    })

    it('creates iteration job with parent_job_id', async () => {
      const mockResponse = { job_id: 'job-456', parent_job_id: 'job-123' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await artifactApi.createJob({
        prompt: 'Add dark mode',
        project_type: 'react-vite',
        style: 'minimal',
        parent_job_id: 'job-123',
      })

      expect(result.parent_job_id).toBe('job-123')
    })
  })

  describe('getJobs', () => {
    it('returns jobs list without status filter', async () => {
      const mockResponse = { jobs: [{ job_id: 'job-1' }, { job_id: 'job-2' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await artifactApi.getJobs()

      expect(result).toEqual(mockResponse)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://artifact.example.com/jobs',
        expect.any(Object)
      )
    })

    it('filters jobs by status when provided', async () => {
      const mockResponse = { jobs: [{ job_id: 'job-1', status: 'done' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await artifactApi.getJobs('done')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://artifact.example.com/jobs?status=done',
        expect.any(Object)
      )
    })
  })

  describe('getJob', () => {
    it('returns single job by id', async () => {
      const mockJob = { job_id: 'job-123', status: 'done', prompt: 'Test' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockJob),
      })

      const result = await artifactApi.getJob('job-123')

      expect(result).toEqual(mockJob)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://artifact.example.com/jobs/job-123',
        expect.any(Object)
      )
    })
  })

  describe('getJobLogs', () => {
    it('returns logs for job', async () => {
      const mockResponse = { logs: 'Build started...\nBuild complete.' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await artifactApi.getJobLogs('job-123')

      expect(result.logs).toBe('Build started...\nBuild complete.')
    })
  })

  describe('getDownloadUrl', () => {
    it('returns download URL for completed job', async () => {
      const mockResponse = { download_url: 'https://s3.example.com/artifact.zip' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await artifactApi.getDownloadUrl('job-123')

      expect(result.download_url).toBe('https://s3.example.com/artifact.zip')
    })
  })

  describe('deleteJob', () => {
    it('deletes job and returns success', async () => {
      const mockResponse = { success: true, message: 'Job deleted' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await artifactApi.deleteJob('job-123')

      expect(result.success).toBe(true)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://artifact.example.com/jobs/job-123',
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('getSourceFiles', () => {
    it('returns files at root when no path provided', async () => {
      const mockResponse = {
        files: [
          { path: 'src', type: 'folder' },
          { path: 'package.json', type: 'file' },
        ],
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await artifactApi.getSourceFiles('job-123')

      expect(result.files).toHaveLength(2)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://artifact.example.com/jobs/job-123/source',
        expect.any(Object)
      )
    })

    it('returns files at specified path', async () => {
      const mockResponse = {
        files: [{ path: 'src/App.tsx', type: 'file' }],
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      await artifactApi.getSourceFiles('job-123', 'src')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://artifact.example.com/jobs/job-123/source?path=src',
        expect.any(Object)
      )
    })
  })

  describe('getSourceFileContent', () => {
    it('returns file content', async () => {
      const mockResponse = { content: 'export default function App() {}', path: 'src/App.tsx' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await artifactApi.getSourceFileContent('job-123', 'src/App.tsx')

      expect(result.content).toBe('export default function App() {}')
      expect(global.fetch).toHaveBeenCalledWith(
        'https://artifact.example.com/jobs/job-123/source/file?path=src%2FApp.tsx',
        expect.any(Object)
      )
    })
  })

  describe('stripTrailingSlashes', () => {
    it('strips trailing slashes from endpoint', async () => {
      mockGetState.mockReturnValue({ config: { artifactBuilderEndpoint: 'https://artifact.example.com///' } })
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ templates: [], styles: [] }),
      })

      await artifactApi.getTemplates()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://artifact.example.com/templates',
        expect.any(Object)
      )
    })
  })
})
