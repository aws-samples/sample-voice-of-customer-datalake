/**
 * @fileoverview The persona protect toggle, end to end through ProjectDetail:
 * what it sends, and that the header follows the saved flag rather than the
 * copy captured when the persona was clicked.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  render, screen, waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest'
import type { Project, ProjectPersona } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import ProjectDetail from './ProjectDetail'

const mockGetProject = vi.fn()
const mockUpdatePersona = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProject: (...args: unknown[]) => mockGetProject(...args),
    getJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    getProductContext: vi.fn().mockResolvedValue({ context: {} }),
    listProductDocs: vi.fn().mockResolvedValue({ docs: [] }),
    updatePersona: (...args: unknown[]) => mockUpdatePersona(...args),
    dismissJob: vi.fn(),
    updateProject: vi.fn(),
  },
}))

const project: Project = {
  project_id: 'proj-1',
  name: 'Protect personas',
  description: '',
  status: 'active',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:00:00Z',
  persona_count: 1,
  document_count: 0,
}

const dana: ProjectPersona = {
  persona_id: 'persona-1',
  name: 'Dana',
  tagline: 'Orders late',
  created_at: '2026-09-01T10:00:00Z',
}

function serve(persona: ProjectPersona) {
  mockGetProject.mockResolvedValue({ project, personas: [persona], documents: [] })
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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

async function openDana(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /personas/i }))
  await user.click(screen.getByRole('button', { name: /@Dana/ }))
}

describe('ProjectDetail persona protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useConfigStore.setState((state) => ({
      config: { ...state.config, apiEndpoint: 'https://api.example.com/v1' },
    }))
    mockUpdatePersona.mockResolvedValue({ success: true })
  })

  it('sends only the protected flag and shows the saved state once the project reloads', async () => {
    serve(dana)
    const user = userEvent.setup()
    renderPage()
    await openDana(user)

    // The server now holds the protected copy; the refetch after the save returns it.
    serve({ ...dana, protected: true })
    await user.click(screen.getByRole('button', { name: 'Protect from regeneration' }))

    expect(mockUpdatePersona).toHaveBeenCalledWith('proj-1', 'persona-1', { protected: true })
    expect(await screen.findByRole('button', { name: 'Stop protecting' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('releases a protected persona', async () => {
    serve({ ...dana, protected: true })
    const user = userEvent.setup()
    renderPage()
    await openDana(user)

    serve(dana)
    await user.click(screen.getByRole('button', { name: 'Stop protecting' }))

    expect(mockUpdatePersona).toHaveBeenCalledWith('proj-1', 'persona-1', { protected: false })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Protect from regeneration' })).toHaveAttribute('aria-pressed', 'false')
    })
  })

  it('leaves another persona\'s toggle usable while one persona\'s save is in flight', async () => {
    const victor: ProjectPersona = { ...dana, persona_id: 'persona-2', name: 'Victor', tagline: 'Compares prices' }
    mockGetProject.mockResolvedValue({ project, personas: [dana, victor], documents: [] })
    const save = Promise.withResolvers<{ success: boolean }>()
    mockUpdatePersona.mockReturnValueOnce(save.promise)
    const user = userEvent.setup()
    renderPage()
    await openDana(user)

    await user.click(screen.getByRole('button', { name: 'Protect from regeneration' }))
    expect(screen.getByRole('button', { name: 'Protect from regeneration' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /@Victor/ }))
    expect(screen.getByRole('button', { name: 'Protect from regeneration' })).toBeEnabled()

    save.resolve({ success: true })
  })

  it('does not re-protect a released persona when it is edited afterwards', async () => {
    // The edit modal saves the whole persona. Seeded from the copy captured at
    // click time, it would carry `protected: true` back and undo the release.
    serve({ ...dana, protected: true })
    const user = userEvent.setup()
    renderPage()
    await openDana(user)

    serve(dana)
    await user.click(screen.getByRole('button', { name: 'Stop protecting' }))
    await screen.findByRole('button', { name: 'Protect from regeneration' })

    await user.click(screen.getByTitle('Edit'))
    await user.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => {
      expect(mockUpdatePersona).toHaveBeenCalledTimes(2)
    })
    const [, , editUpdates] = mockUpdatePersona.mock.calls[1]
    expect(editUpdates).not.toHaveProperty('protected', true)
  })
})
