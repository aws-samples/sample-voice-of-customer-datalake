import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import DocumentsTab from './DocumentsTab'
import { documentsTabStubs, makeProject } from './project-detail-fixtures'
import { EDITOR_ACCESS, VIEWER_ACCESS } from './projectAccess-fixtures'
import type { ProjectDocument } from '../../api/types'
import type { Project } from '../../api/projectTypes'

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

  // QA s3 F4: the selected document offers its Versions (collapsed until opened).
  it('offers the Versions list under the selected document', () => {
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} />)
    expect(screen.getByRole('button', { name: 'Versions' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders document list when documents exist', () => {
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} />)
    expect(screen.getByText('Test Document')).toBeInTheDocument()
  })

  it('renders document type badge', () => {
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} />)
    expect(screen.getByText('PRD')).toBeInTheDocument()
  })

  it('shows select message when no document selected', () => {
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} />)
    expect(screen.getByText('Select a document')).toBeInTheDocument()
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

  it('renders document content when selected', () => {
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} />)
    expect(screen.getByRole('heading', { name: 'Test Content' })).toBeInTheDocument()
  })

  it('renders edit and delete buttons when document selected', () => {
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} />)
    expect(screen.getByTitle('Edit document')).toBeInTheDocument()
    expect(screen.getByTitle('Delete document')).toBeInTheDocument()
  })

  it('calls onEditDoc when edit button is clicked', async () => {
    const user = userEvent.setup()
    const onEditDoc = vi.fn()
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} onEditDoc={onEditDoc} />)
    
    await user.click(screen.getByTitle('Edit document'))
    expect(onEditDoc).toHaveBeenCalledTimes(1)
  })

  it('calls onDeleteDoc when delete button is clicked', async () => {
    const user = userEvent.setup()
    const onDeleteDoc = vi.fn()
    renderWithRouter(<DocumentsTab {...defaultProps} documents={[mockDoc]} selectedDoc={mockDoc} onDeleteDoc={onDeleteDoc} />)
    
    await user.click(screen.getByTitle('Delete document'))
    expect(onDeleteDoc).toHaveBeenCalledTimes(1)
  })

  it('shows a prototype canonical title without generic edit or export controls', () => {
    const onEditDoc = vi.fn()
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
        onEditDoc={onEditDoc}
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
      openInNewTab: true, downloadHtml: true, delete: true,
    })
    expect(onEditDoc).not.toHaveBeenCalled()
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

    it('shows the selected document with export but without Edit or Delete', () => {
      renderWithRouter(<DocumentsTab {...defaultProps} project={viewerProject} documents={[mockDoc]} selectedDoc={mockDoc} />)
      expect(screen.getByRole('heading', { name: 'Test Document' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /download options/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Edit document/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Delete document/i })).not.toBeInTheDocument()
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

  it('keeps Edit and Delete for an editor (explicit can_edit true)', () => {
    const editorProject: Project = { ...mockProject, access: EDITOR_ACCESS }
    renderWithRouter(<DocumentsTab {...defaultProps} project={editorProject} documents={[mockDoc]} selectedDoc={mockDoc} />)
    expect(screen.getByRole('button', { name: /New Document/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Edit document/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Delete document/i })).toBeInTheDocument()
  })
})
