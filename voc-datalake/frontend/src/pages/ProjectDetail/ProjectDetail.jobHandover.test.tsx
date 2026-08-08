/**
 * U9: long-running actions hand their wait to the Background Jobs panel.
 *
 * The bug this pins is not "the callers forgot to tell the panel" — it is that
 * the panel is *structurally blind* to a job it did not start. The jobs query
 * sets refetchInterval to 3000 only while a job is already running or pending,
 * and 0 otherwise (useProjectData). So starting a prototype build on a project
 * with nothing in flight left the panel empty indefinitely: there was no poll
 * running that could ever discover the new job.
 *
 * The assertion is therefore the observable consequence — the jobs query
 * refetches after the build starts — rather than "invalidateQueries was called".
 * A component-level test on the button could only prove it calls its own prop;
 * this proves ProjectDetail actually wires that prop to the query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ProjectDetail from './ProjectDetail'
import { useConfigStore } from '../../store/configStore'
import type { Project, ProjectDocument } from '../../api/types'

const mockGetProject = vi.fn()
const mockGetJobs = vi.fn()
const mockBuildPrototype = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProject: (...args: unknown[]) => mockGetProject(...args),
    getJobs: (...args: unknown[]) => mockGetJobs(...args),
    buildPrototype: (...args: unknown[]) => mockBuildPrototype(...args),
    dismissJob: vi.fn(),
    updateProject: vi.fn(),
  },
}))

const project: Project = {
  project_id: 'proj-1',
  name: 'Reader Engagement',
  description: '',
  status: 'active',
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  persona_count: 0,
  document_count: 1,
}

/**
 * A prototype build needs a PRD or a PR-FAQ to be enabled at all — and both, to
 * skip the single-document confirmation gate that U12 added. The gate has its own
 * tests in BuildPrototypeButton.test.tsx; it is not what these pin.
 */
const documents: ProjectDocument[] = [
  {
    document_id: 'doc-prd',
    title: 'Granular notification controls',
    content: '# PRD',
    document_type: 'prd',
    created_at: '2026-08-01T11:00:00Z',
  },
  {
    document_id: 'doc-prfaq',
    title: 'Granular notification controls',
    content: '# PR-FAQ',
    document_type: 'prfaq',
    created_at: '2026-08-01T11:30:00Z',
  },
]

function renderProjectDetail() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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

describe('ProjectDetail job handover (U9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The real store, not a mock: re-pointing a mocked zustand hook does not
    // notify React, so the query would never be enabled.
    useConfigStore.setState({ config: { ...useConfigStore.getState().config, apiEndpoint: 'https://api.test' } })
    mockGetProject.mockResolvedValue({ project, personas: [], documents })
    // Empty jobs list — the exact state in which the panel used to stay blind.
    mockGetJobs.mockResolvedValue({ jobs: [] })
    mockBuildPrototype.mockResolvedValue({ job_id: 'job-1' })
  })

  it('refetches the jobs list when a prototype build starts with nothing in flight', async () => {
    const user = userEvent.setup()
    renderProjectDetail()

    const buildButton = await screen.findByRole('button', { name: /build prototype/i })
    await waitFor(() => expect(mockGetJobs).toHaveBeenCalled())
    const callsBeforeBuild = mockGetJobs.mock.calls.length

    await user.click(buildButton)

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    // Without the handover this stays at 1 forever: refetchInterval is 0 while
    // no job is known to be running.
    await waitFor(() => expect(mockGetJobs.mock.calls.length).toBeGreaterThan(callsBeforeBuild))
  })

  it('does not disturb the jobs list when the build fails to start', async () => {
    const user = userEvent.setup()
    mockBuildPrototype.mockRejectedValue(new Error('Bedrock unavailable'))
    renderProjectDetail()

    const buildButton = await screen.findByRole('button', { name: /build prototype/i })
    await waitFor(() => expect(mockGetJobs).toHaveBeenCalled())
    const callsBeforeBuild = mockGetJobs.mock.calls.length

    await user.click(buildButton)

    // The start failed, so there is no job to show; the error belongs inline.
    await waitFor(() => expect(screen.getByText(/Bedrock unavailable/)).toBeInTheDocument())
    expect(mockGetJobs.mock.calls.length).toBe(callsBeforeBuild)
  })
})
