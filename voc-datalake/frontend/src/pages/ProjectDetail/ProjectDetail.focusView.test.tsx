/**
 * @fileoverview The document page's focus view through the project page: `?view=focus` on an open document hides the
 * project's header, banner and tabs (the page keeps the window), and leaving brings them back. A `?view=focus` with no
 * page to show changes nothing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectDetail from './ProjectDetail'
import { configureApiEndpoint, pageApi as api, stubPageReads } from './page-api-fixtures'
import { preloadDocumentPage } from './project-detail-fixtures'
import { VIEWER_ACCESS } from './projectAccess-fixtures'
import type { ProjectDocument } from '../../api/types'
import type { Project } from '../../api/projectTypes'

vi.mock('../../api/projectsApi', () => import('./page-api-fixtures').then((m) => ({ projectsApi: m.pageApi })))

await preloadDocumentPage()

const project: Project = {
  project_id: 'proj-1', name: 'Focus project', description: '', status: 'active', created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:00:00Z', persona_count: 0, document_count: 1, visibility: 'private', access: VIEWER_ACCESS,
}
const document: ProjectDocument = {
  document_id: 'res-1', document_type: 'research', title: 'Churn notes', content: '# Churn', created_at: '2026-09-01T10:00:00Z',
}

function renderAt(entry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path="/projects/:id" element={<ProjectDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The project's chrome on screen: its tabs, its header (the name) and the read-only banner. */
const chrome = () => ({
  tabs: screen.queryByRole('tablist') !== null,
  header: screen.queryByText('Focus project') !== null,
  banner: screen.queryByText(/view-only access/i) !== null,
})

describe('ProjectDetail in the document page\'s focus view', () => {
  beforeAll(configureApiEndpoint)
  beforeEach(() => {
    stubPageReads([])
    api.getProject.mockResolvedValue({ project, personas: [], documents: [document] })
  })

  it('hides the project header, the read-only banner and the tabs, and shows them again on leaving', async () => {
    const user = userEvent.setup()
    renderAt('/projects/proj-1?tab=documents&doc=res-1&view=focus')
    const toggle = await screen.findByRole('button', { name: 'Full screen' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(chrome()).toStrictEqual({ tabs: false, header: false, banner: false })

    await user.click(toggle)
    expect(await screen.findByRole('tablist')).toBeInTheDocument()
    expect(chrome()).toStrictEqual({ tabs: true, header: true, banner: true })
  })

  it('changes nothing without a document page to show', async () => {
    renderAt('/projects/proj-1?tab=documents&view=focus')
    expect(await screen.findByRole('tablist')).toBeInTheDocument()
    expect(screen.getByText('Focus project')).toBeInTheDocument()
  })
})
