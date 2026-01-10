/**
 * @fileoverview Tests for Projects page component.
 * @module pages/Projects
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'

// Mock API
const mockGetProjects = vi.fn()
const mockCreateProject = vi.fn()
const mockDeleteProject = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getProjects: () => mockGetProjects(),
    createProject: (data: unknown) => mockCreateProject(data),
    deleteProject: (id: string) => mockDeleteProject(id),
  },
}))

// Mock config store
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    config: { apiEndpoint: 'https://api.example.com' },
  })),
}))

// Mock navigate
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

// Mock ConfirmModal
vi.mock('../../components/ConfirmModal', () => ({
  default: ({ isOpen, onConfirm, onCancel, title }: { isOpen: boolean; onConfirm: () => void; onCancel: () => void; title: string }) =>
    isOpen ? (
      <div data-testid="confirm-modal">
        <span>{title}</span>
        <button onClick={onConfirm}>Confirm Delete</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}))

import Projects from './Projects'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={['/projects']}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
}

const mockProjectsData = {
  projects: [
    {
      project_id: 'proj_1',
      name: 'Q1 Product Improvements',
      description: 'Analyzing customer feedback for Q1',
      status: 'active',
      created_at: '2025-01-15T10:00:00Z',
      updated_at: '2025-01-15T10:00:00Z',
      persona_count: 3,
      document_count: 5,
    },
    {
      project_id: 'proj_2',
      name: 'Customer Support Analysis',
      description: 'Support ticket analysis',
      status: 'active',
      created_at: '2025-01-10T10:00:00Z',
      updated_at: '2025-01-10T10:00:00Z',
      persona_count: 2,
      document_count: 3,
    },
  ],
}

describe('Projects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProjects.mockResolvedValue(mockProjectsData)
    mockCreateProject.mockResolvedValue({ project_id: 'proj_new', name: 'New Project' })
    mockDeleteProject.mockResolvedValue({ success: true })
  })

  describe('not configured state', () => {
    it('displays configuration prompt when API endpoint not set', async () => {
      vi.resetModules()
      vi.doMock('../../store/configStore', () => ({
        useConfigStore: () => ({
          config: { apiEndpoint: '' },
        }),
      }))
      
      const { default: ProjectsNotConfigured } = await import('./Projects')
      
      render(<ProjectsNotConfigured />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Configure API endpoint/i)).toBeInTheDocument()
    })
  })

  describe('loading state', () => {
    it('displays loading skeleton while fetching projects', () => {
      mockGetProjects.mockReturnValue(new Promise(() => {}))
      
      render(<Projects />, { wrapper: createWrapper() })
      
      expect(document.querySelector('.animate-pulse')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('displays empty state when no projects exist', async () => {
      mockGetProjects.mockResolvedValue({ projects: [] })
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText(/No projects yet/i)).toBeInTheDocument()
      })
    })

    it('displays create project button in empty state', async () => {
      mockGetProjects.mockResolvedValue({ projects: [] })
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Project/i })).toBeInTheDocument()
      })
    })
  })

  describe('projects display', () => {
    it('displays project cards after loading', async () => {
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Q1 Product Improvements')).toBeInTheDocument()
        expect(screen.getByText('Customer Support Analysis')).toBeInTheDocument()
      })
    })

    it('displays project description', async () => {
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Analyzing customer feedback for Q1')).toBeInTheDocument()
      })
    })

    it('displays persona count for each project', async () => {
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('3 personas')).toBeInTheDocument()
        expect(screen.getByText('2 personas')).toBeInTheDocument()
      })
    })

    it('displays document count for each project', async () => {
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('5 docs')).toBeInTheDocument()
        expect(screen.getByText('3 docs')).toBeInTheDocument()
      })
    })

    it('displays creation date for each project', async () => {
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Jan 15, 2025')).toBeInTheDocument()
      })
    })
  })

  describe('header', () => {
    it('displays page title', () => {
      render(<Projects />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Projects')).toBeInTheDocument()
    })

    it('displays page description', () => {
      render(<Projects />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Create projects to build personas/i)).toBeInTheDocument()
    })

    it('displays New Project button in header', () => {
      render(<Projects />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /New Project/i })).toBeInTheDocument()
    })
  })

  describe('create project', () => {
    it('opens create modal when New Project button is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /New Project/i }))
      
      expect(screen.getByText('Create New Project')).toBeInTheDocument()
    })

    it('displays project name input in create modal', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /New Project/i }))
      
      expect(screen.getByPlaceholderText(/Q1 Product Improvements/i)).toBeInTheDocument()
    })

    it('displays description textarea in create modal', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /New Project/i }))
      
      expect(screen.getByPlaceholderText(/What is this project about/i)).toBeInTheDocument()
    })

    it('creates project when form is submitted', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /New Project/i }))
      await user.type(screen.getByPlaceholderText(/Q1 Product Improvements/i), 'Test Project')
      await user.type(screen.getByPlaceholderText(/What is this project about/i), 'Test description')
      await user.click(screen.getByRole('button', { name: /Create Project$/i }))
      
      await waitFor(() => {
        expect(mockCreateProject).toHaveBeenCalledWith({
          name: 'Test Project',
          description: 'Test description',
        })
      })
    })

    it('disables create button when name is empty', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /New Project/i }))
      
      const createButton = screen.getByRole('button', { name: /Create Project$/i })
      expect(createButton).toBeDisabled()
    })

    it('closes modal when Cancel is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /New Project/i }))
      await user.click(screen.getByRole('button', { name: /Cancel/i }))
      
      expect(screen.queryByText('Create New Project')).not.toBeInTheDocument()
    })

    it('closes modal after successful creation', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /New Project/i }))
      await user.type(screen.getByPlaceholderText(/Q1 Product Improvements/i), 'Test Project')
      await user.click(screen.getByRole('button', { name: /Create Project$/i }))
      
      await waitFor(() => {
        expect(screen.queryByText('Create New Project')).not.toBeInTheDocument()
      })
    })
  })

  describe('open project', () => {
    it('navigates to project detail when Open Project is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Q1 Product Improvements')).toBeInTheDocument()
      })
      
      const openButtons = screen.getAllByRole('button', { name: /Open Project/i })
      await user.click(openButtons[0])
      
      expect(mockNavigate).toHaveBeenCalledWith('/projects/proj_1')
    })
  })

  describe('delete project', () => {
    it('opens confirm modal when delete button is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Q1 Product Improvements')).toBeInTheDocument()
      })
      
      // Find and click delete button (trash icon)
      const deleteButtons = document.querySelectorAll('button')
      const deleteButton = Array.from(deleteButtons).find(btn => 
        btn.querySelector('svg.lucide-trash-2')
      )
      
      if (deleteButton) {
        await user.click(deleteButton)
      }
      
      await waitFor(() => {
        expect(screen.getByTestId('confirm-modal')).toBeInTheDocument()
      })
    })

    it('deletes project when confirmed', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Q1 Product Improvements')).toBeInTheDocument()
      })
      
      // Find and click delete button
      const deleteButtons = document.querySelectorAll('button')
      const deleteButton = Array.from(deleteButtons).find(btn => 
        btn.querySelector('svg.lucide-trash-2')
      )
      
      if (deleteButton) {
        await user.click(deleteButton)
      }
      
      await waitFor(() => {
        expect(screen.getByTestId('confirm-modal')).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /Confirm Delete/i }))
      
      await waitFor(() => {
        expect(mockDeleteProject).toHaveBeenCalled()
      })
    })

    it('closes confirm modal when cancelled', async () => {
      const user = userEvent.setup()
      
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Q1 Product Improvements')).toBeInTheDocument()
      })
      
      // Find and click delete button
      const deleteButtons = document.querySelectorAll('button')
      const deleteButton = Array.from(deleteButtons).find(btn => 
        btn.querySelector('svg.lucide-trash-2')
      )
      
      if (deleteButton) {
        await user.click(deleteButton)
      }
      
      await waitFor(() => {
        expect(screen.getByTestId('confirm-modal')).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /Cancel/i }))
      
      await waitFor(() => {
        expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument()
      })
    })
  })

  describe('API calls', () => {
    it('fetches projects on mount', async () => {
      render(<Projects />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(mockGetProjects).toHaveBeenCalled()
      })
    })
  })
})
