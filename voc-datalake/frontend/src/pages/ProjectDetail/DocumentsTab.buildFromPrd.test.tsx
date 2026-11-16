/**
 * Where a PRD's "Build from this PRD" sits on the document page (7.47.00): above a PRD's page only, out of the way in
 * focus view like the list, and never remounting the page when focus view comes and goes. The bar's own behaviour is
 * BuildFromPrd.test.tsx's; here it is a stub.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient as render } from '@test/query-client'
import { documentsTabStubs, makeProject, preloadDocumentPage } from './project-detail-fixtures'
import type { ProjectDocument } from '../../api/types'

vi.mock('./BuildFromPrd', async () => {
  const { createElement } = await import('react')
  return {
    default: ({ documentId }: { readonly documentId: string }) => createElement('p', { 'data-testid': 'build-from-prd' }, documentId),
  }
})

const { default: DocumentsTab } = await import('./DocumentsTab')
await preloadDocumentPage()

const project = makeProject({ project_id: 'proj-1', name: 'Test Project', description: '' })
const prd: ProjectDocument = {
  document_id: 'doc-1', title: 'Test PRD', content: '# Test Content', document_type: 'prd',
  created_at: new Date().toISOString(),
}
const research: ProjectDocument = { ...prd, document_id: 'doc-2', title: 'Test Research', document_type: 'research' }

const renderTab = (document: ProjectDocument, entry = '/projects/proj-1/documents') => render(
  <MemoryRouter initialEntries={[entry]}>
    <DocumentsTab project={project} documents={[document]} selectedDoc={document} onSelectDoc={vi.fn()}
      {...documentsTabStubs()} />
  </MemoryRouter>,
)

describe('Build from this PRD on the document page', () => {
  it('sits above a PRD\'s page, naming that PRD, and not above another document\'s', async () => {
    const { unmount } = renderTab(prd)
    await screen.findByTestId('document-detail-pane')
    expect(screen.getByTestId('build-from-prd').textContent).toBe('doc-1')
    unmount()

    renderTab(research)
    await screen.findByTestId('document-detail-pane')
    expect(screen.queryByTestId('build-from-prd')).toBeNull()
  })

  it('steps aside in focus view and comes back on leaving it, the page never remounted', async () => {
    const user = userEvent.setup()
    renderTab(prd, '/projects/proj-1/documents/doc-1/focus')
    const toggle = await screen.findByRole('button', { name: 'Full screen' })
    const pane = screen.getByTestId('document-detail-pane')
    expect([toggle.getAttribute('aria-pressed'), screen.queryByTestId('build-from-prd')]).toStrictEqual(['true', null])

    await user.click(toggle)
    expect(screen.getByRole('button', { name: 'Full screen' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('build-from-prd').textContent).toBe('doc-1')
    expect(screen.getByTestId('document-detail-pane')).toBe(pane)
  })
})
