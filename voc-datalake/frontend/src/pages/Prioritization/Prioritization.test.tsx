/**
 * @fileoverview Tests for Prioritization page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

// Mock API
const mockGetProjects = vi.fn()
const mockGetProject = vi.fn()
const mockGetPrioritizationScores = vi.fn()
const mockSavePrioritizationScores = vi.fn()
const mockPatchPrioritizationScores = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getProjects: () => mockGetProjects(),
    getProject: (id: string) => mockGetProject(id),
    getPrioritizationScores: () => mockGetPrioritizationScores(),
    savePrioritizationScores: (scores: unknown) => mockSavePrioritizationScores(scores),
    patchPrioritizationScores: (scores: unknown) => mockPatchPrioritizationScores(scores),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com' },
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'title': 'PR/FAQ Prioritization',
        'subtitle': 'Score and prioritize PR/FAQs across all projects',
        'loading': 'Loading PR/FAQs...',
        'empty.title': 'No PR/FAQs Found',
        'empty.description': 'Create PR/FAQs in your projects to start prioritizing.',
        'stats.totalPrfaqs': 'Total PR/FAQs',
        'stats.highPriority': 'High Priority',
        'stats.mediumPriority': 'Medium Priority',
        'stats.notScored': 'Not Scored',
        'sort.label': 'Sort by:',
        'sort.impact': 'Impact',
        'sort.priorityFull': 'Priority Score',
        'sort.ttmFull': 'Time to Market',
        'sort.dateFull': 'Date Created',
        'scores.title': 'Prioritization Scores',
        'scores.impact': 'Impact',
        'scores.score': 'Score',
        'sort.ttm': 'TTM',
        'preview.title': 'PR/FAQ Preview',
        'preview.viewFull': 'View Full Document',
        'priority.none': 'Not Scored',
        'actions.save': 'Save Scores',
        'actions.saveMobile': 'Save',
      }
      return translations[key] ?? key
    },
    i18n: { changeLanguage: () => Promise.resolve() },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))

import Prioritization from './Prioritization'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  
  const router = createMemoryRouter([
    { path: '/', element: <Prioritization /> },
  ])
  
  return ({ children }: { children?: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

const mockProjects = [
  { project_id: 'p1', name: 'Project 1', status: 'active', created_at: '2025-01-01', updated_at: '2025-01-01', persona_count: 2, document_count: 3 },
  { project_id: 'p2', name: 'Project 2', status: 'active', created_at: '2025-01-02', updated_at: '2025-01-02', persona_count: 1, document_count: 2 },
]

const mockProjectDetails = [
  {
    project_id: 'p1',
    documents: [
      { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '# Feature A\n\nThis is a great feature.', created_at: '2025-01-01' },
      { document_id: 'd2', document_type: 'prd', title: 'Feature A PRD', content: 'PRD content', created_at: '2025-01-01' },
    ],
  },
  {
    project_id: 'p2',
    documents: [
      { document_id: 'd3', document_type: 'prfaq', title: 'Feature B PR/FAQ', content: '# Feature B', created_at: '2025-01-02' },
    ],
  },
]

describe('Prioritization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProjects.mockResolvedValue({ projects: mockProjects })
    mockGetProject.mockImplementation((id) => {
      const detail = mockProjectDetails.find(d => d.project_id === id)
      return Promise.resolve(detail || { documents: [] })
    })
    mockGetPrioritizationScores.mockResolvedValue({ scores: {} })
    mockSavePrioritizationScores.mockResolvedValue({ success: true })
    mockPatchPrioritizationScores.mockResolvedValue({ success: true, updated_count: 1 })
  })

  function renderPrioritization() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    
    const router = createMemoryRouter([
      { path: '/', element: <Prioritization /> },
    ])
    
    return render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )
  }

  describe('rendering', () => {
    it('renders page header', async () => {
      renderPrioritization()

      expect(screen.getByText('PR/FAQ Prioritization')).toBeInTheDocument()
      expect(screen.getByText(/score and prioritize/i)).toBeInTheDocument()
    })

    it('renders stats cards', async () => {
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Total PR/FAQs')).toBeInTheDocument()
        expect(screen.getByText('High Priority')).toBeInTheDocument()
        expect(screen.getByText('Medium Priority')).toBeInTheDocument()
        expect(screen.getByText('Not Scored')).toBeInTheDocument()
      })
    })

    it('renders sort controls', async () => {
      renderPrioritization()

      expect(screen.getByText('Sort by:')).toBeInTheDocument()
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', async () => {
      mockGetProjects.mockReturnValue(new Promise(() => {})) // Never resolves

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Loading PR/FAQs...')).toBeInTheDocument()
      })
    })
  })

  describe('empty state', () => {
    it('shows empty state when no PR/FAQs exist', async () => {
      mockGetProjects.mockResolvedValue({ projects: [] })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('No PR/FAQs Found')).toBeInTheDocument()
      })
    })
  })

  describe('PR/FAQ list', () => {
    it('displays PR/FAQ items after loading', async () => {
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
        expect(screen.getByText('Feature B PR/FAQ')).toBeInTheDocument()
      })
    })

    it('shows project name for each PR/FAQ', async () => {
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Project 1')).toBeInTheDocument()
        expect(screen.getByText('Project 2')).toBeInTheDocument()
      })
    })

    it('shows Not Scored label for unscored items', async () => {
      renderPrioritization()

      await waitFor(() => {
        const notScoredLabels = screen.getAllByText('Not Scored')
        expect(notScoredLabels.length).toBeGreaterThan(0)
      })
    })
  })

  describe('expand/collapse', () => {
    it('expands PR/FAQ row when clicked', async () => {
      const user = userEvent.setup()
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Feature A PR/FAQ'))

      await waitFor(() => {
        expect(screen.getByText('Prioritization Scores')).toBeInTheDocument()
        expect(screen.getByText('PR/FAQ Preview')).toBeInTheDocument()
      })
    })
  })

  describe('sorting', () => {
    it('changes sort when clicking sort button', async () => {
      const user = userEvent.setup()
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      // Click on Impact sort button
      const impactButton = screen.getByRole('button', { name: /impact/i })
      await user.click(impactButton)

      // Button should be highlighted
      expect(impactButton).toHaveClass('bg-blue-100')
    })
  })

  describe('save functionality', () => {
    it('save button is disabled when no changes', async () => {
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      const saveButton = screen.getByRole('button', { name: /save/i })
      expect(saveButton).toBeDisabled()
    })
  })
})

// Note: Testing "not configured" state requires module re-mocking which is complex
// The main functionality is tested above
