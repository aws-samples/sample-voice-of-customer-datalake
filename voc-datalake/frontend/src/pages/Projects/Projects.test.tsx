/**
 * @fileoverview Tests for Projects page component.
 * @module pages/Projects
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/TestRouter'
import { navigateSpy as mockNavigate } from '../../test/page-mocks'

// Mock API
const mockGetProjects = vi.fn<(...args: unknown[]) => unknown>()
const mockCreateProject = vi.fn<(...args: unknown[]) => unknown>()
const mockDeleteProject = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProjects: () => mockGetProjects(),
    createProject: (data: unknown) => mockCreateProject(data),
    deleteProject: (id: string) => mockDeleteProject(id),
  },
}))

// Mock config store
vi.mock('../../store/configStore', () => import('@test/page-mocks').then((m) => m.configStoreHookMock({
  config: { apiEndpoint: 'https://api.example.com' },
})))

// Mock navigate
vi.mock('react-router-dom', () => import('@test/page-mocks').then((m) => m.routerWithNavigateSpy()))

// Mock ConfirmModal
vi.mock('../../components/ConfirmModal/ConfirmModal', () => import('@test/page-mocks').then((m) => m.confirmModalMock('Confirm Delete')))

import Projects from './Projects'
import { at } from '@test/defined'

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
      // The caller manages this one, so its card offers delete.
      access: { role: 'owner', can_view: true, can_edit: true, can_manage: true },
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

function renderProjects() {
  render(<Projects />, { wrapper: createWrapper() })
}

function renderEmptyList() {
  mockGetProjects.mockResolvedValue({ projects: [] })
  renderProjects()
}

/** Render, click the header button and hand back the user for the modal. */
async function openCreateModal() {
  const user = userEvent.setup()
  renderProjects()
  await user.click(screen.getByRole('button', { name: /New Project/i }))
  return user
}

function typeProjectName(user: ReturnType<typeof userEvent.setup>, name: string) {
  return user.type(screen.getByPlaceholderText(/Q1 Product Improvements/i), name)
}

function submitCreateForm(user: ReturnType<typeof userEvent.setup>) {
  return user.click(screen.getByRole('button', { name: /Create Project$/i }))
}

/** Render and wait for the first fixture card to be on screen. */
async function renderLoadedList() {
  const user = userEvent.setup()
  renderProjects()
  await waitFor(() => {
    expect(screen.getByText('Q1 Product Improvements')).toBeInTheDocument()
  })
  return user
}

/** Click the first card's delete control and assert the confirm modal opened. */
async function expectDeleteConfirmOpen() {
  const user = await renderLoadedList()
  await user.click(screen.getByRole('button', { name: 'Delete project Q1 Product Improvements' }))
  await waitFor(() => {
    expect(screen.getByTestId('confirm-modal')).toBeInTheDocument()
  })
  return user
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
      
      renderProjects()
      
      // LoadingSkeleton uses `.skeleton` blocks (the recipe pulses), not role="status"
      expect(document.querySelector('.skeleton')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('displays empty state when no projects data returned', async () => {
      // When query returns undefined data, empty state is shown after loading
      renderEmptyList()
      
      // An empty list shows the empty state (it used to render an empty grid,
      // because the check only caught a nullish `projects`).
      await waitFor(() => {
        expect(screen.getByText('Projects')).toBeInTheDocument()
      })
      expect(await screen.findByText('No projects yet')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Create Project' })).toBeInTheDocument()
    })

    it('displays New Project button when projects list is empty', async () => {
      renderEmptyList()
      
      await waitFor(() => {
        // The header New Project button is always visible
        expect(screen.getByRole('button', { name: /New Project/i })).toBeInTheDocument()
      })
    })

    // Regression (e2e network.spec.ts, P3): a failed list read used to fall
    // through to "No projects yet" + "Create Project" — offline, the page told
    // the user they had no projects.
    it('says the list could not be loaded, not "no projects", when the read fails', async () => {
      mockGetProjects.mockRejectedValueOnce(new Error('Failed to fetch'))
      renderProjects()

      expect(await screen.findByRole('alert')).toHaveTextContent('This could not be loaded. Check your connection and try again.')
      expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Create Project' })).not.toBeInTheDocument()
    })

    it('recovers in place when the failed read is retried', async () => {
      mockGetProjects.mockRejectedValueOnce(new Error('Failed to fetch'))
      const user = userEvent.setup()
      renderProjects()

      await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Try again' }))

      expect(await screen.findByText('Q1 Product Improvements')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('projects display', () => {
    it('displays project cards after loading', async () => {
      renderProjects()
      
      await waitFor(() => {
        expect(screen.getByText('Q1 Product Improvements')).toBeInTheDocument()
        expect(screen.getByText('Customer Support Analysis')).toBeInTheDocument()
      })
    })

    it('displays project description', async () => {
      renderProjects()
      
      await waitFor(() => {
        expect(screen.getByText('Analyzing customer feedback for Q1')).toBeInTheDocument()
      })
    })

    it('displays persona count for each project', async () => {
      renderProjects()
      
      await waitFor(() => {
        expect(screen.getByText('3 personas')).toBeInTheDocument()
        expect(screen.getByText('2 personas')).toBeInTheDocument()
      })
    })

    it('displays document count for each project', async () => {
      renderProjects()
      
      await waitFor(() => {
        expect(screen.getByText('5 docs')).toBeInTheDocument()
        expect(screen.getByText('3 docs')).toBeInTheDocument()
      })
    })

    it('displays creation date for each project', async () => {
      renderProjects()
      
      await waitFor(() => {
        expect(screen.getByText('Jan 15, 2025')).toBeInTheDocument()
      })
    })
  })

  describe('header', () => {
    it('displays page title', () => {
      renderProjects()
      
      expect(screen.getByText('Projects')).toBeInTheDocument()
    })

    it('displays page description', () => {
      renderProjects()
      
      expect(screen.getByText(/Create projects to build personas/i)).toBeInTheDocument()
    })

    it('displays New Project button in header', () => {
      renderProjects()
      
      expect(screen.getByRole('button', { name: /New Project/i })).toBeInTheDocument()
    })
  })

  describe('create project', () => {
    it('opens create modal when New Project button is clicked', async () => {
      await openCreateModal()
      
      expect(screen.getByText('Create New Project')).toBeInTheDocument()
    })

    it('displays project name input in create modal', async () => {
      await openCreateModal()
      
      expect(screen.getByPlaceholderText(/Q1 Product Improvements/i)).toBeInTheDocument()
    })

    it('displays description textarea in create modal', async () => {
      await openCreateModal()
      
      expect(screen.getByPlaceholderText(/What is this project about/i)).toBeInTheDocument()
    })

    it('creates project when form is submitted', async () => {
      const user = await openCreateModal()
      await typeProjectName(user, 'Test Project')
      await user.type(screen.getByPlaceholderText(/What is this project about/i), 'Test description')
      await submitCreateForm(user)
      
      await waitFor(() => {
        expect(mockCreateProject).toHaveBeenCalledWith({
          name: 'Test Project',
          description: 'Test description',
          visibility: 'private',
        })
      })
    })

    it('disables create button when name is empty', async () => {
      await openCreateModal()
      
      const createButton = screen.getByRole('button', { name: /Create Project$/i })
      expect(createButton).toBeDisabled()
    })

    it('closes modal when Cancel is clicked', async () => {
      const user = await openCreateModal()
      await user.click(screen.getByRole('button', { name: /Cancel/i }))
      
      expect(screen.queryByText('Create New Project')).not.toBeInTheDocument()
    })

    it('closes modal after successful creation', async () => {
      const user = await openCreateModal()
      await typeProjectName(user, 'Test Project')
      await submitCreateForm(user)
      
      await waitFor(() => {
        expect(screen.queryByText('Create New Project')).not.toBeInTheDocument()
      })
    })
  })

  describe('open project', () => {
    it('navigates to project detail when Open Project is clicked', async () => {
      const user = await renderLoadedList()
      
      const openButtons = screen.getAllByRole('button', { name: /Open Project/i })
      await user.click(at(openButtons, 0))
      
      expect(mockNavigate).toHaveBeenCalledWith('/projects/proj_1')
    })
  })

  describe('delete project', () => {
    it('opens confirm modal when delete button is clicked', async () => {
      await expectDeleteConfirmOpen()
    })

    it('deletes project when confirmed', async () => {
      const user = await expectDeleteConfirmOpen()
      
      await user.click(screen.getByRole('button', { name: /Confirm Delete/i }))
      
      await waitFor(() => {
        expect(mockDeleteProject).toHaveBeenCalledExactlyOnceWith('proj_1')
      })
    })

    it('closes confirm modal when cancelled', async () => {
      const user = await expectDeleteConfirmOpen()
      
      await user.click(screen.getByRole('button', { name: /Cancel/i }))
      
      await waitFor(() => {
        expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument()
      })
    })
  })

  describe('API calls', () => {
    it('fetches projects on mount', async () => {
      renderProjects()
      
      await waitFor(() => {
        expect(mockGetProjects).toHaveBeenCalledWith()
      })
    })
  })

  // Visibility in the create payload, the card's visibility badge and owner,
  // and the delete control gated on can_manage.
  describe('sharing UI', () => {
    const base = {
      description: '',
      status: 'active',
      created_at: '2025-01-15T10:00:00Z',
      updated_at: '2025-01-15T10:00:00Z',
      persona_count: 0,
      document_count: 0,
    }

    const sharingProjects = [
      {
        ...base,
        project_id: 'mine',
        name: 'Mine',
        visibility: 'private',
        owner: { sub: 'sub-me', username: 'me', email: 'me@example.com' },
        access: { role: 'owner', can_view: true, can_edit: true, can_manage: true },
      },
      {
        ...base,
        project_id: 'shared',
        name: 'Shared',
        visibility: 'public',
        owner: { sub: 'sub-o', username: '', email: 'other@example.com' },
        access: { role: 'editor', can_view: true, can_edit: true, can_manage: false },
      },
      // Legacy-shaped: no sharing fields at all.
      { ...base, project_id: 'legacy', name: 'Legacy' },
    ]

    function card(name: string): HTMLElement {
      const heading = screen.getByRole('heading', { name })
      const root = heading.closest<HTMLElement>('.card')
      if (root === null) throw new Error(`no card for ${name}`)
      return root
    }

    async function renderSharingList() {
      mockGetProjects.mockResolvedValue({ projects: sharingProjects })
      renderProjects()
      await screen.findByText('Mine')
    }

    it('shows a visibility badge on every card, defaulting legacy rows to Public', async () => {
      await renderSharingList()

      expect(within(card('Mine')).getByTestId('project-visibility-badge')).toHaveAttribute('data-visibility', 'private')
      expect(within(card('Mine')).getByTestId('project-visibility-badge')).toHaveTextContent('Private')
      expect(within(card('Shared')).getByTestId('project-visibility-badge')).toHaveTextContent('Public')
      expect(within(card('Legacy')).getByTestId('project-visibility-badge')).toHaveTextContent('Public')
    })

    it('shows the owner, falling back to email when there is no username', async () => {
      await renderSharingList()

      expect(within(card('Mine')).getByText('Owner: me')).toBeInTheDocument()
      expect(within(card('Shared')).getByText('Owner: other@example.com')).toBeInTheDocument()
      expect(within(card('Legacy')).queryByText(/Owner:/)).not.toBeInTheDocument()
    })

    it('offers delete only where the caller can manage', async () => {
      await renderSharingList()

      expect(within(card('Mine')).getByRole('button', { name: 'Delete project Mine' })).toBeInTheDocument()
      expect(within(card('Shared')).queryByRole('button', { name: /Delete project/ })).not.toBeInTheDocument()
      expect(within(card('Legacy')).queryByRole('button', { name: /Delete project/ })).not.toBeInTheDocument()
    })

    it('defaults a new project to Private and explains both choices', async () => {
      await openCreateModal()
      expect(screen.getByRole('radio', { name: /Private/ })).toBeChecked()
      expect(screen.getByText('Only the owner, invited members, and admins can see it.')).toBeInTheDocument()
      expect(screen.getByText('Everyone in this workspace can view and edit it.')).toBeInTheDocument()
    })

    it.each([
      { choice: /Private/, name: 'Secret', visibility: 'private' },
      { choice: /Public/, name: 'Open', visibility: 'public' },
    ])('sends $visibility when chosen', async ({ choice, name, visibility }) => {
      const user = await openCreateModal()
      await typeProjectName(user, name)
      await user.click(screen.getByRole('radio', { name: choice }))
      await submitCreateForm(user)

      await waitFor(() => expect(mockCreateProject).toHaveBeenCalledWith({ name, description: '', visibility }))
    })
  })
})
