import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import DocumentsTab from './DocumentsTab'
import type { ProjectDocument, Project } from '../../api/client'

const mockProject: Project = {
  project_id: 'proj-1',
  name: 'Test Project',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const mockDoc: ProjectDocument = {
  document_id: 'doc-1',
  title: 'Test Document',
  content: '# Test Content',
  doc_type: 'prd',
  document_type: 'prd',
  created_at: new Date().toISOString(),
}

const defaultProps = {
  project: mockProject,
  documents: [] as ProjectDocument[],
  selectedDoc: null,
  onSelectDoc: vi.fn(),
  onEditDoc: vi.fn(),
  onDeleteDoc: vi.fn(),
  onCreateDoc: vi.fn(),
  isDeleting: false,
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
    const docButton = buttons.find(b => b.textContent?.includes('Test Document'))
    expect(docButton).toHaveClass('bg-blue-50', 'border-blue-300')
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
})
