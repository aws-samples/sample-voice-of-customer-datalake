/**
 * @fileoverview The canvas's save in place (useCanvasDocument) for its specs: the documents, `mount` (the harness of
 * canvas-harness-fixtures in a data router, so the route guard is live), the stand-in editor, and a PUT that stores
 * what it is sent. The spec file mocks `api/projectsApi` itself (vi.mock is per file) and passes its
 * `updateDocument` spy where a helper needs it.
 */
import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { vi } from 'vitest'
import { createTestQueryClient } from '../../../test/query-client'
import { makeProject } from '../../../pages/ProjectDetail/project-detail-fixtures'
import { Harness } from './canvas-harness-fixtures'
import type { Mock } from 'vitest'
import type { ProjectDocument } from '../../../api/types'
import type { RevisedBy } from './useCanvasDocument'

export const project = makeProject({ project_id: 'p1' })
export const custom: ProjectDocument = {
  document_id: 'doc-1', document_type: 'custom', title: 'Notes', content: 'stored', revision: 4, created_at: '2026-10-01T00:00:00Z',
}
export const prd: ProjectDocument = {
  document_id: 'prd-2', document_type: 'prd', base_title: 'Launch', version: 2, title: 'Launch (v2)', content: '# PRD',
  created_at: '2026-10-01T00:00:00Z',
}

/** `projectsApi.updateDocument` as the specs spy on it (projectId, documentId, body, reviseJobId). */
export type UpdateDocument = (projectId: string, documentId: string, body: Record<string, unknown>, reviseJobId?: string) => Promise<unknown>

/** Mounted in a data router (so the route guard is live), under a fresh query client; `revisedBy`: what the
 *  harness's "revised" button marks (default: the pass "job-7", kept by any text). */
export function mount(document: ProjectDocument, canvasProject = project, revisedBy?: RevisedBy) {
  const onSelectDoc = vi.fn<(doc: ProjectDocument) => void>()
  const harness = revisedBy === undefined ? { document, onSelectDoc, canvasProject } : { document, onSelectDoc, canvasProject, revisedBy }
  const router = createMemoryRouter([
    { path: '/doc', element: createElement(Harness, harness) },
    { path: '/elsewhere', element: createElement('p', null, 'elsewhere') },
  ], { initialEntries: ['/doc'] })
  render(createElement(QueryClientProvider, { client: createTestQueryClient() }, createElement(RouterProvider, { router })))
  return { onSelectDoc, router, user: userEvent.setup() }
}

/** The stand-in editor (a textarea named "canvas"). */
export const canvas = () => screen.getByRole('textbox', { name: 'canvas' })

/** Every PUT answers the version it stored: `edited` with the content sent, one revision on. */
export function putStores(updateDocument: Mock<UpdateDocument>, edited: ProjectDocument) {
  updateDocument.mockImplementation((_projectId, _documentId, body) =>
    Promise.resolve({ document: { ...edited, content: body.content, revision: (edited.revision ?? 0) + 1 } }))
}
