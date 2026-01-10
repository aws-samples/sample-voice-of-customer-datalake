/**
 * @fileoverview Tests for useArtifactBuilderState hook
 * @module pages/ArtifactBuilder/useArtifactBuilderState.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

// Mock config store
const mockConfigStore = vi.fn()
vi.mock('../../store/configStore', () => ({
  useConfigStore: () => mockConfigStore(),
}))

// Mock artifactApi
const mockGetTemplates = vi.fn()
const mockGetJobs = vi.fn()
const mockGetJob = vi.fn()
const mockGetJobLogs = vi.fn()
const mockGetDownloadUrl = vi.fn()
const mockCreateJob = vi.fn()
const mockDeleteJob = vi.fn()
const mockGetSourceFiles = vi.fn()
const mockGetSourceFileContent = vi.fn()

vi.mock('../../api/artifactApi', () => ({
  artifactApi: {
    getTemplates: () => mockGetTemplates(),
    getJobs: () => mockGetJobs(),
    getJob: (id: string) => mockGetJob(id),
    getJobLogs: (id: string) => mockGetJobLogs(id),
    getDownloadUrl: (id: string) => mockGetDownloadUrl(id),
    createJob: (data: unknown) => mockCreateJob(data),
    deleteJob: (id: string) => mockDeleteJob(id),
    getSourceFiles: (id: string, path?: string) => mockGetSourceFiles(id, path),
    getSourceFileContent: (id: string, path: string) => mockGetSourceFileContent(id, path),
  },
}))

// Mock clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
})

import { useArtifactBuilderState } from './useArtifactBuilderState'

function createWrapper(initialEntries: string[] = ['/']) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('useArtifactBuilderState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigStore.mockReturnValue({ config: { artifactBuilderEndpoint: 'https://artifact.example.com' } })
    mockGetTemplates.mockResolvedValue({
      templates: [{ id: 'react-vite', name: 'React + Vite' }],
      styles: [{ id: 'minimal', name: 'Minimal' }],
    })
    mockGetJobs.mockResolvedValue({ jobs: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Configuration', () => {
    it('returns isConfigured true when endpoint is set', () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      expect(result.current.isConfigured).toBe(true)
    })

    it('returns isConfigured false when endpoint is empty', () => {
      mockConfigStore.mockReturnValue({ config: { artifactBuilderEndpoint: '' } })

      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      expect(result.current.isConfigured).toBe(false)
    })
  })

  describe('Templates and Styles', () => {
    it('fetches templates on mount', async () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      await waitFor(() => {
        expect(result.current.templates).toHaveLength(1)
        expect(result.current.templates[0].id).toBe('react-vite')
      })
    })

    it('fetches styles on mount', async () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      await waitFor(() => {
        expect(result.current.styles).toHaveLength(1)
        expect(result.current.styles[0].id).toBe('minimal')
      })
    })

    it('provides default templates when fetch fails', async () => {
      mockGetTemplates.mockRejectedValue(new Error('Network error'))

      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      await waitFor(() => {
        expect(result.current.templates).toEqual([{ id: 'react-vite', name: 'React + Vite' }])
      })
    })
  })

  describe('Jobs', () => {
    it('returns empty jobs array initially', () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      // Jobs start as empty array
      expect(result.current.jobs).toEqual([])
    })

    it('returns grouped jobs structure', () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      // groupedJobs is derived from jobs
      expect(Array.isArray(result.current.groupedJobs)).toBe(true)
    })
  })

  describe('Job Selection', () => {
    it('selects job when setSelectedJobId is called', async () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      act(() => {
        result.current.setSelectedJobId('job-123')
      })

      expect(result.current.selectedJobId).toBe('job-123')
    })
  })

  describe('Expand/Collapse Parents', () => {
    it('toggles parent expansion', () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      act(() => {
        result.current.toggleParentExpanded('job-1')
      })

      expect(result.current.expandedParents.has('job-1')).toBe(true)

      act(() => {
        result.current.toggleParentExpanded('job-1')
      })

      expect(result.current.expandedParents.has('job-1')).toBe(false)
    })
  })

  describe('Detail Tab', () => {
    it('changes detail tab', () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      expect(result.current.detailTab).toBe('preview')

      act(() => {
        result.current.setDetailTab('logs')
      })

      expect(result.current.detailTab).toBe('logs')
    })
  })

  describe('Build Modal', () => {
    it('opens and closes build modal', () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      expect(result.current.showBuildModal).toBe(false)

      act(() => {
        result.current.setShowBuildModal(true)
      })

      expect(result.current.showBuildModal).toBe(true)

      act(() => {
        result.current.setShowBuildModal(false)
      })

      expect(result.current.showBuildModal).toBe(false)
    })
  })

  describe('Iterate Modal', () => {
    it('opens iterate modal with job ID', () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      act(() => {
        result.current.openIterateModal('job-123')
      })

      expect(result.current.showIterateModal).toBe(true)
      expect(result.current.iterateFromJobId).toBe('job-123')
    })

    it('closes iterate modal', () => {
      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      act(() => {
        result.current.openIterateModal('job-123')
      })

      act(() => {
        result.current.closeIterateModal()
      })

      expect(result.current.showIterateModal).toBe(false)
      expect(result.current.iterateFromJobId).toBeNull()
    })
  })

  describe('Source Modal', () => {
    it('opens source modal', async () => {
      mockGetSourceFiles.mockResolvedValue({ files: [] })

      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      await act(async () => {
        await result.current.openSourceModal('job-123')
      })

      expect(result.current.showSourceModal).toBe(true)
      expect(result.current.sourceJobId).toBe('job-123')
    })

    it('closes source modal and resets state', async () => {
      mockGetSourceFiles.mockResolvedValue({ files: [] })

      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      await act(async () => {
        await result.current.openSourceModal('job-123')
      })

      act(() => {
        result.current.closeSourceModal()
      })

      expect(result.current.showSourceModal).toBe(false)
      expect(result.current.sourceJobId).toBeNull()
      expect(result.current.sourceFiles).toEqual([])
    })

    it('copies clone command to clipboard', async () => {
      mockGetSourceFiles.mockResolvedValue({ files: [] })

      const { result } = renderHook(() => useArtifactBuilderState(), { wrapper: createWrapper() })

      await act(async () => {
        await result.current.openSourceModal('job-123')
      })

      act(() => {
        result.current.copyCloneCommand()
      })

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'git clone codecommit::us-west-2://artifact-job-123'
      )
      expect(result.current.copiedClone).toBe(true)
    })
  })
})
