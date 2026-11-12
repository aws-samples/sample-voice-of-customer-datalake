import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithQueryClient as render } from '@test/query-client'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import DocumentsTab from './DocumentsTab'
import { documentsTabStubs, makeProject, preloadDocumentPage } from './project-detail-fixtures'
import { EDITOR_ACCESS, VIEWER_ACCESS } from './projectAccess-fixtures'
import type { ProjectDocument } from '../../api/types'
import type { Project } from '../../api/projectTypes'

await preloadDocumentPage()

const mockProject = makeProject({ project_id: 'proj-1', name: 'Test Project', description: '' })

const mockDoc: ProjectDocument = {
  document_id: 'doc-1',
  title: 'Test Document',
  content: '# Test Content',
  document_type: 'prd',
  created_at: new Date().toISOString(),
}

const noDocuments: ProjectDocument[] = []

const defaultProps = {
  project: mockProject,
  documents: noDocuments,
  selectedDoc: null,
  onSelectDoc: vi.fn(),
  ...documentsTabStubs(),
}

const renderWithRouter = (ui: React.ReactElement) => {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('DocumentsTab', () => {
  it('renders New Document button', () => {
    renderWithRouter(<DocumentsTab {...defaultProps} />)
    expect(screen.getByRole('button', { name: /New Document/i })).toBeInTheDocument()
  })

  it('renders empty state when no documents', () => {
    renderWithRouter(<DocumentsTab {...defaultProps} />)
    expect(screen.getByText('No documents')).toBeInTheDocument()
  })

  it('calls onCreateDoc when New Document button is clicked', async () => {
    const user = userEvent.setup()
    const onCreateDoc = vi.fn()
    renderWithRouter(<DocumentsTab {...defaultProps} onCreateDoc={onCreateDoc} />)
    
    await user.click(screen.getByRole('button', { name: /New Document/i }))
    expect(onCreateDoc).toHaveBeenCalledTimes(1)
  })

  // The prose page is lazy-loaded (the editor's bundle loads only on this tab); its action bar holds the versions.
  it('opens a prose document on its page, with the action bar', async () => {
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} />)
    const pane = await screen.findByTestId('document-detail-pane')
    expect(within(pane).getByTestId('document-actions-bar')).toBeInTheDocument()
    expect(within(pane).getByRole('heading', { level: 2, name: 'Test Document' })).toBeInTheDocument()
  })

  it.each<[outcome: string, text: string]>([
    ['renders document list when documents exist', 'Test Document'],
    ['renders document type badge', 'PRD'],
    ['shows select message when no document selected', 'Select a document'],
  ])('%s', (_outcome, text) => {
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} />)
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('calls onSelectDoc when document is clicked', async () => {
    const user = userEvent.setup()
    const onSelectDoc = vi.fn()
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} onSelectDoc={onSelectDoc} />)
    
    await user.click(screen.getByText('Test Document'))
    expect(onSelectDoc).toHaveBeenCalledWith(mockDoc)
  })

  it('highlights selected document', () => {
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} />)
    const buttons = screen.getAllByRole('button')
    const docButton = buttons.find(b => b.textContent.includes('Test Document'))
    expect(docButton).toHaveClass('bg-accent-subtle', 'border-accent/40')
  })

  it('renders document content when selected', async () => {
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} />)
    // The canvas draws the stored Markdown as rich text: `# Test Content` is the page's first heading.
    expect(await screen.findByRole('heading', { level: 1, name: 'Test Content' })).toBeInTheDocument()
  })

  // Edited in place: no Edit (pencil) button and no edit modal; Delete is in the page bar's File menu.
  it('offers Delete in the page bar\'s File menu and no Edit button for a prose document', async () => {
    const user = userEvent.setup()
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} />)
    const bar = await screen.findByTestId('document-actions-bar')
    await user.click(within(bar).getByRole('button', { name: 'File' }))
    expect(screen.getByRole('menuitem', { name: 'Delete document' })).toBeInTheDocument()
    expect(screen.queryByTitle('Edit document')).not.toBeInTheDocument()
  })

  it('calls onDeleteDoc when Delete is chosen', async () => {
    const user = userEvent.setup()
    const onDeleteDoc = vi.fn()
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} onDeleteDoc={onDeleteDoc} />)

    await user.click(await screen.findByRole('button', { name: 'File' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete document' }))
    expect(onDeleteDoc).toHaveBeenCalledTimes(1)
  })

  // The focus view (`?view=focus`): the page keeps the window; "New document" and the list step aside, and come back.
  it('hides New Document and the list while the page is in focus view, and shows them again on leaving', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/projects/proj-1?tab=documents&doc=doc-1&view=focus']}>
        <DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} />
      </MemoryRouter>,
    )
    const toggle = await screen.findByRole('button', { name: 'Full screen' })
    const around = () => ({
      pressed: screen.getByRole('button', { name: 'Full screen' }).getAttribute('aria-pressed'),
      newDocument: screen.queryByRole('button', { name: /New Document/i }) !== null,
      list: screen.queryByRole('button', { name: /Test Document$/ }) !== null,
    })
    expect(around()).toStrictEqual({ pressed: 'true', newDocument: false, list: false })

    await user.click(toggle)
    expect(around()).toStrictEqual({ pressed: 'false', newDocument: true, list: true })
  })

  it('shows a prototype canonical title without generic edit or export controls', () => {
    const prototype: ProjectDocument = {
      document_id: 'prototype-3',
      document_type: 'prototype',
      title: 'Checkout prototype (v3)',
      base_title: 'Checkout prototype',
      version: 3,
      content: '<html><body>Checkout</body></html>',
      prototype_format: 'html',
      created_at: '2026-09-03T00:00:00Z',
    }

    renderWithRouter(
      <DocumentsTab
        {...defaultProps}
        documents={[prototype]}
        selectedDoc={prototype}
      />,
    )

    const shown = (element: HTMLElement | null) => element !== null
    expect({
      heading: shown(screen.queryByRole('heading', { level: 2, name: 'Checkout prototype (v3)' })),
      listEntry: shown(screen.queryByRole('button', { name: /Checkout prototype \(v3\)/ })),
      edit: shown(screen.queryByTitle('Edit document')),
      downloadMenu: shown(screen.queryByRole('button', { name: /download options/i })),
      openInNewTab: shown(screen.queryByRole('button', { name: /open in new tab/i })),
      downloadHtml: shown(screen.queryByRole('button', { name: /download \.html/i })),
      delete: shown(screen.queryByTitle('Delete document')),
    }).toStrictEqual({
      heading: true, listEntry: true, edit: false, downloadMenu: false,
      // No "Open in new tab" for inline HTML: a blob: URL runs at the app's own origin (FE-3).
      openInNewTab: false, downloadHtml: true, delete: true,
    })
  })

  it('keeps a dedicated download affordance for inline JSON prototypes', () => {
    const prototype: ProjectDocument = {
      document_id: 'prototype-json',
      document_type: 'prototype',
      title: 'Legacy prototype (v1)',
      content: JSON.stringify({
        title: 'Legacy prototype',
        screens: [{ id: 'home', heading: 'Home' }],
      }),
      created_at: '2026-09-03T00:00:00Z',
    }

    renderWithRouter(
      <DocumentsTab
        {...defaultProps}
        documents={[prototype]}
        selectedDoc={prototype}
      />,
    )

    expect(screen.getByRole('button', { name: /download \.json/i })).toBeInTheDocument()
    expect(screen.queryByTitle('Edit document')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /download options/i })).not.toBeInTheDocument()
  })

  // A viewer member reads and exports documents; create / edit / delete would
  // all be refused by the project gate, so none of them is offered.
  describe('for a viewer (project.access.can_edit false)', () => {
    const viewerProject: Project = { ...mockProject, access: VIEWER_ACCESS }

    it('offers no New Document button', () => {
      renderWithRouter(<DocumentsTab {...defaultProps} project={viewerProject} />)
      expect(screen.queryByRole('button', { name: /New Document/i })).not.toBeInTheDocument()
    })

    it('shows the selected document with export but without Edit or Delete', async () => {
      const user = userEvent.setup()
      renderWithRouter(<DocumentsTab {...defaultProps} project={viewerProject} documents={[mockDoc]} selectedDoc={mockDoc} />)
      expect(await screen.findByRole('heading', { name: 'Test Document' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'File' }))
      expect(screen.getByRole('menuitem', { name: /download as markdown/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Edit document/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('menuitem', { name: /Delete document/i })).not.toBeInTheDocument()
    })

    it('shows a prototype preview without the revise-with-feedback control', () => {
      const prototype: ProjectDocument = {
        ...mockDoc,
        document_id: 'proto-1',
        document_type: 'prototype',
        prototype_format: 'html',
        content: '<!doctype html><html><body>hi</body></html>',
      }
      renderWithRouter(<DocumentsTab {...defaultProps} project={viewerProject} documents={[prototype]} selectedDoc={prototype} />)
      expect(screen.queryByRole('button', { name: /feedback/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Delete document/i })).not.toBeInTheDocument()
    })
  })

  it('keeps New Document and Delete for an editor (explicit can_edit true)', async () => {
    const editorProject: Project = { ...mockProject, access: EDITOR_ACCESS }
    const user = userEvent.setup()
    renderWithRouter(<DocumentsTab {...defaultProps} project={editorProject} documents={[mockDoc]} selectedDoc={mockDoc} />)
    expect(screen.getByRole('button', { name: /New Document/i })).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'File' }))
    expect(screen.getByRole('menuitem', { name: /Delete document/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit document/i })).not.toBeInTheDocument()
  })

  it('edits a research document in place: its title is a field on the page', async () => {
    const research: ProjectDocument = { ...mockDoc, document_id: 'res-1', document_type: 'research', title: 'Churn research' }
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[research]} selectedDoc={research} />)
    expect(await screen.findByRole('textbox', { name: 'Document title' })).toHaveValue('Churn research')
  })
})
