import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  render, screen, waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest'
import type { Project, ProjectDocument } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import ProjectDetail from './ProjectDetail'
import { emptyProductContext } from './productContextFields'

const mockGetProject = vi.fn()
const mockGetJobs = vi.fn()
const mockGetProductContext = vi.fn()
const mockListProductDocs = vi.fn()
const mockUpdateDocument = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProject: (...args: unknown[]) => mockGetProject(...args),
    getJobs: (...args: unknown[]) => mockGetJobs(...args),
    getProductContext: (...args: unknown[]) => mockGetProductContext(...args),
    listProductDocs: (...args: unknown[]) => mockListProductDocs(...args),
    updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
    dismissJob: vi.fn(),
    updateProject: vi.fn(),
  },
}))

const project: Project = {
  project_id: 'proj-1',
  name: 'Versioned documents',
  description: '',
  status: 'active',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:00:00Z',
  persona_count: 0,
  document_count: 1,
}

const managedDocument: ProjectDocument = {
  document_id: 'prd-2',
  document_type: 'prd',
  base_title: 'Launch',
  version: 2,
  title: 'Launch (v2)',
  content: '# Original content',
  created_at: '2026-09-01T10:00:00Z',
}

const legacyManagedDocument: ProjectDocument = {
  document_id: 'legacy-prfaq-2',
  document_type: 'custom',
  sk: 'PRFAQ#legacy-prfaq-2',
  title: 'Legacy launch (v2)',
  content: '# Original legacy content',
  created_at: '2026-09-01T10:00:00Z',
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/proj-1']}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ProjectDetail managed document edits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useConfigStore.setState((state) => ({
      config: { ...state.config, apiEndpoint: 'https://api.example.com/v1' },
    }))
    mockGetProject.mockResolvedValue({
      project,
      personas: [],
      documents: [managedDocument],
    })
    mockGetJobs.mockResolvedValue({ jobs: [] })
    mockGetProductContext.mockResolvedValue({ context: emptyProductContext() })
    mockListProductDocs.mockResolvedValue({ docs: [] })
    mockUpdateDocument.mockResolvedValue({ success: true })
  })

  it('submits content only and preserves the canonical selected title', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /documents/i }))
    await user.click(screen.getByRole('button', { name: /Launch \(v2\)/ }))
    expect(screen.getByRole('heading', { name: 'Launch (v2)', level: 2 }))
      .toBeInTheDocument()

    await user.click(screen.getByTitle('Edit document'))
    const title = screen.getByPlaceholderText('Document title...')
    expect(title).toBeDisabled()
    expect(title).toHaveValue('Launch (v2)')

    const content = screen.getByPlaceholderText(/Write your document/)
    await user.clear(content)
    await user.type(content, '# Edited content')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(mockUpdateDocument).toHaveBeenCalledWith(
        'proj-1',
        'prd-2',
        { content: '# Edited content' },
      )
    })
    expect(screen.getByRole('heading', { name: 'Launch (v2)', level: 2 }))
      .toBeInTheDocument()
  })

  it('uses the legacy managed sort key to protect the title and omit it from updates', async () => {
    mockGetProject.mockResolvedValue({
      project,
      personas: [],
      documents: [legacyManagedDocument],
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /documents/i }))
    await user.click(screen.getByRole('button', { name: /Legacy launch \(v2\)/ }))
    await user.click(screen.getByTitle('Edit document'))

    expect(screen.getByPlaceholderText('Document title...')).toBeDisabled()
    const content = screen.getByPlaceholderText(/Write your document/)
    await user.clear(content)
    await user.type(content, '# Edited legacy content')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(mockUpdateDocument).toHaveBeenCalledWith(
        'proj-1',
        'legacy-prfaq-2',
        { content: '# Edited legacy content' },
      )
    })
  })
})
