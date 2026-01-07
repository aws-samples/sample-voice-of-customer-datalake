/**
 * @fileoverview Tests for ArtifactBuilder page component.
 * @module pages/ArtifactBuilder
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'

// Mock the custom hook
const mockUseArtifactBuilderState = vi.fn()

vi.mock('./useArtifactBuilderState', () => ({
  useArtifactBuilderState: () => mockUseArtifactBuilderState(),
}))

import ArtifactBuilder from './ArtifactBuilder'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={['/artifacts']}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
}

const mockJob = {
  job_id: 'job_123',
  status: 'done',
  prompt: 'Create a dashboard',
  project_type: 'react-vite',
  style: 'minimal',
  include_mock_data: true,
  preview_url: 'https://preview.example.com',
  created_at: '2025-01-15T10:00:00Z',
}

const mockGroupedJobs = [
  {
    job_id: 'job_123',
    status: 'done',
    prompt: 'Create a dashboard',
    created_at: '2025-01-15T10:00:00Z',
    iterations: [],
  },
  {
    job_id: 'job_456',
    status: 'building',
    prompt: 'Create a landing page',
    created_at: '2025-01-14T10:00:00Z',
    iterations: [],
  },
]

const defaultState = {
  isConfigured: true,
  templates: [{ id: 'react-vite', name: 'React + Vite' }],
  styles: [{ id: 'minimal', name: 'Minimal' }, { id: 'modern', name: 'Modern' }],
  jobs: [mockJob],
  groupedJobs: mockGroupedJobs,
  jobsLoading: false,
  selectedJob: null,
  logsData: null,
  downloadData: null,
  selectedJobId: null,
  setSelectedJobId: vi.fn(),
  expandedParents: new Set<string>(),
  toggleParentExpanded: vi.fn(),
  detailTab: 'preview' as const,
  setDetailTab: vi.fn(),
  showBuildModal: false,
  setShowBuildModal: vi.fn(),
  createJob: { isPending: false, error: null, mutate: vi.fn() },
  handleCreateJob: vi.fn(),
  showIterateModal: false,
  iterateFromJobId: null,
  openIterateModal: vi.fn(),
  closeIterateModal: vi.fn(),
  iterateJob: { isPending: false, mutate: vi.fn() },
  handleIterate: vi.fn(),
  showSourceModal: false,
  sourceJobId: null,
  openSourceModal: vi.fn(),
  closeSourceModal: vi.fn(),
  sourceFiles: [],
  sourceFilesLoading: false,
  selectedSourceFile: null,
  sourceFileContent: '',
  sourceFileLoading: false,
  currentSourcePath: '',
  loadSourceFiles: vi.fn(),
  handleLoadSourceFileContent: vi.fn(),
  copyCloneCommand: vi.fn(),
  copiedClone: false,
  deleteJob: { isPending: false, mutate: vi.fn() },
}

describe('ArtifactBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseArtifactBuilderState.mockReturnValue(defaultState)
  })

  describe('not configured state', () => {
    it('displays configuration prompt when not configured', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        isConfigured: false,
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Configure the Artifact Builder/i)).toBeInTheDocument()
    })
  })

  describe('header', () => {
    it('displays page title', () => {
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Artifacts')).toBeInTheDocument()
    })

    it('displays page description', () => {
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Generated web prototypes/i)).toBeInTheDocument()
    })

    it('displays Build New Artifact button', () => {
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /Build New Artifact/i })).toBeInTheDocument()
    })
  })

  describe('jobs list', () => {
    it('displays All Artifacts heading', () => {
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText('All Artifacts')).toBeInTheDocument()
    })

    it('displays loading spinner when jobs are loading', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        jobsLoading: true,
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })

    it('displays empty state when no jobs exist', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        jobs: [],
        groupedJobs: [],
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/No artifacts yet/i)).toBeInTheDocument()
    })

    it('displays job cards when jobs exist', () => {
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/job_123/i)).toBeInTheDocument()
    })
  })

  describe('job selection', () => {
    it('displays no job selected message when no job is selected', () => {
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Select an artifact/i)).toBeInTheDocument()
    })

    it('displays job details when a job is selected', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Job #job_123/i)).toBeInTheDocument()
    })
  })

  describe('job detail tabs', () => {
    it('displays preview tab', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /Preview/i })).toBeInTheDocument()
    })

    it('displays prompt tab', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /Prompt/i })).toBeInTheDocument()
    })

    it('displays logs tab', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /Logs/i })).toBeInTheDocument()
    })
  })

  describe('preview tab content', () => {
    it('displays iframe when job is done with preview URL', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
        detailTab: 'preview',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      const iframe = document.querySelector('iframe')
      expect(iframe).toBeInTheDocument()
      expect(iframe).toHaveAttribute('src', 'https://preview.example.com')
    })

    it('displays building message when job is in progress', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: { ...mockJob, status: 'building', preview_url: undefined },
        selectedJobId: 'job_123',
        detailTab: 'preview',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Building artifact/i)).toBeInTheDocument()
    })
  })

  describe('prompt tab content', () => {
    it('displays prompt text', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
        detailTab: 'prompt',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      // Prompt text appears in both job card and prompt tab, use getAllByText
      const promptElements = screen.getAllByText('Create a dashboard')
      expect(promptElements.length).toBeGreaterThanOrEqual(1)
    })

    it('displays project type badge', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
        detailTab: 'prompt',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText('react-vite')).toBeInTheDocument()
    })

    it('displays style badge', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
        detailTab: 'prompt',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText('minimal')).toBeInTheDocument()
    })
  })

  describe('logs tab content', () => {
    it('displays logs when available', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
        detailTab: 'logs',
        logsData: { logs: 'Build started...\nBuild complete!' },
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Build started/i)).toBeInTheDocument()
    })

    it('displays waiting message when no logs', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
        detailTab: 'logs',
        logsData: null,
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Waiting for logs/i)).toBeInTheDocument()
    })
  })

  describe('job status', () => {
    it('displays done status badge', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      // Status "done" is displayed as "Complete" in the UI (appears in job card and detail)
      const completeElements = screen.getAllByText('Complete')
      expect(completeElements.length).toBeGreaterThanOrEqual(1)
    })

    it('displays error message when job failed', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: { ...mockJob, status: 'failed', error: 'Build failed due to syntax error' },
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Build failed due to syntax error/i)).toBeInTheDocument()
    })
  })

  describe('build modal', () => {
    it('opens build modal when Build New Artifact is clicked', async () => {
      const setShowBuildModal = vi.fn()
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        setShowBuildModal,
      })
      
      const user = userEvent.setup()
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /Build New Artifact/i }))
      
      expect(setShowBuildModal).toHaveBeenCalledWith(true)
    })
  })

  describe('job actions', () => {
    it('displays iterate button for completed jobs', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /Iterate/i })).toBeInTheDocument()
    })

    it('displays source button for completed jobs', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /Source/i })).toBeInTheDocument()
    })

    it('displays delete button', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: mockJob,
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument()
    })
  })

  describe('parent job info', () => {
    it('displays parent job info when job has parent', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: { ...mockJob, parent_job_id: 'parent_123' },
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Iterated from job/i)).toBeInTheDocument()
    })

    it('displays view parent link', () => {
      mockUseArtifactBuilderState.mockReturnValue({
        ...defaultState,
        selectedJob: { ...mockJob, parent_job_id: 'parent_123' },
        selectedJobId: 'job_123',
      })
      
      render(<ArtifactBuilder />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/View parent/i)).toBeInTheDocument()
    })
  })
})
