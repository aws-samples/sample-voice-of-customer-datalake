/**
 * The project's Focus groups tab (7.64.00) through the project page: `/projects/<id>/focus-groups` opens it with the
 * project's personas and documents (FocusGroupsTab.tsx has its own spec, mocked here).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectDetail from './ProjectDetail'
import { configureApiEndpoint, pageApi as api, stubPageReads } from './page-api-fixtures'
import { VIEWER_ACCESS } from './projectAccess-fixtures'
import type { Project } from '../../api/projectTypes'

vi.mock('../../api/projectsApi', () => import('./page-api-fixtures').then((m) => ({ projectsApi: m.pageApi })))
vi.mock('./focusGroups/FocusGroupsTab', () => ({
  default: ({ documents }: { readonly documents: readonly unknown[] }) => <p data-testid="focus-groups-tab">{documents.length} documents</p>,
}))

const project: Project = {
  project_id: 'proj-1', name: 'Groups project', description: '', status: 'active', created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:00:00Z', persona_count: 0, document_count: 0, visibility: 'private', access: VIEWER_ACCESS,
}

describe('ProjectDetail → Focus groups', () => {
  beforeAll(configureApiEndpoint)
  beforeEach(() => {
    stubPageReads([])
    api.getProject.mockResolvedValue({ project, personas: [], documents: [] })
  })

  it('opens the Focus groups tab at its path', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/projects/proj-1/focus-groups']}>
          <Routes><Route path="/projects/:id/*" element={<ProjectDetail />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByTestId('focus-groups-tab')).toHaveTextContent('0 documents')
  })
})
