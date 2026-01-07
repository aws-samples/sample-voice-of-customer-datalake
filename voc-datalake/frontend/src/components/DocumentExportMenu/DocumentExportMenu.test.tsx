/**
 * @fileoverview Tests for DocumentExportMenu component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentExportMenu from './DocumentExportMenu'
import type { ProjectDocument, Project } from '../../api/client'

describe('DocumentExportMenu', () => {
  const mockDocument: ProjectDocument = {
    document_id: 'doc-1',
    title: 'Test PRD',
    content: '# Test PRD\n\nThis is a test document.',
    document_type: 'prd',
    created_at: '2025-01-15T10:00:00Z',
  }

  const mockProject: Project = {
    project_id: 'proj-1',
    name: 'Test Project',
    description: 'A test project',
    status: 'active',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-15T00:00:00Z',
    persona_count: 3,
    document_count: 5,
    kiro_export_prompt: 'Build this feature using React',
  }

  // Mock clipboard
  const mockWriteText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteText.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    })
  })

  describe('visibility', () => {
    it('returns null when document is null', () => {
      const { container } = render(<DocumentExportMenu document={null} />)
      expect(container.firstChild).toBeNull()
    })
  })

  describe('menu toggle', () => {
    it('renders menu button', () => {
      render(<DocumentExportMenu document={mockDocument} />)
      expect(screen.getByLabelText('Download options')).toBeInTheDocument()
    })

    it('opens menu when button is clicked', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)
      
      await user.click(screen.getByLabelText('Download options'))
      
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('closes menu when clicking outside', async () => {
      const user = userEvent.setup()
      render(
        <div>
          <DocumentExportMenu document={mockDocument} />
          <div data-testid="outside">Outside</div>
        </div>
      )
      
      await user.click(screen.getByLabelText('Download options'))
      expect(screen.getByRole('menu')).toBeInTheDocument()
      
      await user.click(screen.getByTestId('outside'))
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })
    })
  })

  describe('menu items', () => {
    it('displays Copy option', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)
      
      await user.click(screen.getByLabelText('Download options'))
      
      expect(screen.getByText('Copy')).toBeInTheDocument()
    })

    it('displays Download as Markdown option', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)
      
      await user.click(screen.getByLabelText('Download options'))
      
      expect(screen.getByText('Download as Markdown')).toBeInTheDocument()
    })

    it('displays Download as PDF option', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)
      
      await user.click(screen.getByLabelText('Download options'))
      
      expect(screen.getByText('Download as PDF')).toBeInTheDocument()
    })

    it('displays Download as TXT option', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)
      
      await user.click(screen.getByLabelText('Download options'))
      
      expect(screen.getByText('Download as TXT')).toBeInTheDocument()
    })
  })

  describe('copy to kiro', () => {
    it('shows Copy to Kiro option for PRD documents', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} project={mockProject} />)
      
      await user.click(screen.getByLabelText('Download options'))
      
      expect(screen.getByText('Copy to Kiro')).toBeInTheDocument()
    })

    it('shows Copy to Kiro option for PRFAQ documents', async () => {
      const user = userEvent.setup()
      const prfaqDoc: ProjectDocument = { ...mockDocument, document_type: 'prfaq' }
      render(<DocumentExportMenu document={prfaqDoc} project={mockProject} />)
      
      await user.click(screen.getByLabelText('Download options'))
      
      expect(screen.getByText('Copy to Kiro')).toBeInTheDocument()
    })

    it('does not show Copy to Kiro for research documents', async () => {
      const user = userEvent.setup()
      const researchDoc: ProjectDocument = { ...mockDocument, document_type: 'research' }
      render(<DocumentExportMenu document={researchDoc} project={mockProject} />)
      
      await user.click(screen.getByLabelText('Download options'))
      
      expect(screen.queryByText('Copy to Kiro')).not.toBeInTheDocument()
    })

    it('shows tip when kiro_export_prompt is not configured', async () => {
      const user = userEvent.setup()
      const projectWithoutPrompt = { ...mockProject, kiro_export_prompt: undefined }
      render(<DocumentExportMenu document={mockDocument} project={projectWithoutPrompt} />)
      
      await user.click(screen.getByLabelText('Download options'))
      
      expect(screen.getByText(/configure kiro prompt/i)).toBeInTheDocument()
    })
  })

  describe('copy functionality', () => {
    it('copies document content to clipboard', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)
      
      await user.click(screen.getByLabelText('Download options'))
      await user.click(screen.getByText('Copy'))
      
      // Verify copy happened by checking the "Copied!" feedback appears
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })

    it('shows Copied! after copying', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)
      
      await user.click(screen.getByLabelText('Download options'))
      await user.click(screen.getByText('Copy'))
      
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })
  })

  describe('accessibility', () => {
    it('has correct aria attributes on menu button', () => {
      render(<DocumentExportMenu document={mockDocument} />)
      
      const button = screen.getByLabelText('Download options')
      expect(button).toHaveAttribute('aria-haspopup', 'menu')
    })

    it('sets aria-expanded correctly', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)
      
      const button = screen.getByLabelText('Download options')
      expect(button).toHaveAttribute('aria-expanded', 'false')
      
      await user.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'true')
    })
  })
})
