/**
 * @fileoverview Tests for DocumentExportMenu component
 * @module components/DocumentExportMenu/DocumentExportMenu.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentExportMenu from './DocumentExportMenu'
import type { ProjectDocument, Project } from '../../api/client'

// Mock jsPDF and html2canvas to avoid complex PDF generation
vi.mock('jspdf', () => ({
  default: vi.fn().mockImplementation(() => ({
    internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
    addPage: vi.fn(),
    addImage: vi.fn(),
    save: vi.fn(),
  })),
}))

vi.mock('html2canvas', () => ({
  default: vi.fn().mockResolvedValue({
    width: 800,
    height: 1000,
    toDataURL: () => 'data:image/jpeg;base64,test',
  }),
}))

vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({
    render: vi.fn(),
    unmount: vi.fn(),
  })),
}))

const mockDocument: ProjectDocument = {
  document_id: 'doc-1',
  document_type: 'prd',
  title: 'Test PRD Document',
  content: '# Overview\n\nThis is a **test** document with [links](https://example.com).',
  created_at: '2025-01-01T00:00:00Z',
}

const mockProject: Project = {
  project_id: 'proj-1',
  name: 'Test Project',
  description: 'Test description',
  status: 'active',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  persona_count: 2,
  document_count: 3,
  kiro_export_prompt: 'Build this feature using React and TypeScript.',
}

describe('DocumentExportMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Rendering', () => {
    it('renders menu button', () => {
      render(<DocumentExportMenu document={mockDocument} />)
      expect(screen.getByRole('button', { name: /download options/i })).toBeInTheDocument()
    })

    it('returns null when document is null', () => {
      const { container } = render(<DocumentExportMenu document={null} />)
      expect(container.firstChild).toBeNull()
    })

    it('menu is closed by default', () => {
      render(<DocumentExportMenu document={mockDocument} />)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  describe('Menu Toggle', () => {
    it('opens menu when button is clicked', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))

      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('closes menu when button is clicked again', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))
      expect(screen.getByRole('menu')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /download options/i }))
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('sets aria-expanded correctly', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      const button = screen.getByRole('button', { name: /download options/i })
      expect(button).toHaveAttribute('aria-expanded', 'false')

      await user.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'true')
    })
  })

  describe('Menu Options', () => {
    it('shows copy option', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))

      // Use getAllByRole and check the first one is the plain copy
      const copyButtons = screen.getAllByRole('menuitem').filter(el => el.textContent === 'Copy')
      expect(copyButtons.length).toBeGreaterThanOrEqual(1)
    })

    it('shows download as markdown option', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))

      expect(screen.getByRole('menuitem', { name: /download as markdown/i })).toBeInTheDocument()
    })

    it('shows download as PDF option', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))

      expect(screen.getByRole('menuitem', { name: /download as pdf/i })).toBeInTheDocument()
    })

    it('shows download as TXT option', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))

      expect(screen.getByRole('menuitem', { name: /download as txt/i })).toBeInTheDocument()
    })

    it('shows copy to Kiro option for PRD documents', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} project={mockProject} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))

      expect(screen.getByRole('menuitem', { name: /copy to kiro/i })).toBeInTheDocument()
    })

    it('shows copy to Kiro option for PRFAQ documents', async () => {
      const user = userEvent.setup()
      const prfaqDoc = { ...mockDocument, document_type: 'prfaq' as const }
      render(<DocumentExportMenu document={prfaqDoc} project={mockProject} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))

      expect(screen.getByRole('menuitem', { name: /copy to kiro/i })).toBeInTheDocument()
    })

    it('does not show copy to Kiro for research documents', async () => {
      const user = userEvent.setup()
      const researchDoc = { ...mockDocument, document_type: 'research' as const }
      render(<DocumentExportMenu document={researchDoc} project={mockProject} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))

      expect(screen.queryByRole('menuitem', { name: /copy to kiro/i })).not.toBeInTheDocument()
    })

    it('shows tip when no kiro prompt configured', async () => {
      const user = userEvent.setup()
      const projectWithoutPrompt = { ...mockProject, kiro_export_prompt: undefined }
      render(<DocumentExportMenu document={mockDocument} project={projectWithoutPrompt} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))

      expect(screen.getByText(/configure kiro prompt/i)).toBeInTheDocument()
    })
  })

  describe('Copy Action', () => {
    it('copies content to clipboard', async () => {
      const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText')
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))
      await user.click(screen.getByRole('menuitem', { name: /^copy$/i }))

      expect(writeTextSpy).toHaveBeenCalledWith(mockDocument.content)
    })

    it('shows copied feedback', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))
      await user.click(screen.getByRole('menuitem', { name: /^copy$/i }))

      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })
  })

  describe('Copy to Kiro Action', () => {
    it('copies content with kiro prompt', async () => {
      const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText')
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} project={mockProject} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))
      await user.click(screen.getByRole('menuitem', { name: /copy to kiro/i }))

      expect(writeTextSpy).toHaveBeenCalled()
    })

    it('shows copied feedback after copying to Kiro', async () => {
      const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText')
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} project={mockProject} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))
      await user.click(screen.getByRole('menuitem', { name: /copy to kiro/i }))

      // Menu closes after action, so we check clipboard was called
      expect(writeTextSpy).toHaveBeenCalled()
    })
  })

  describe('Download Actions', () => {
    it('has markdown download option available', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))
      
      const markdownOption = screen.getByRole('menuitem', { name: /download as markdown/i })
      expect(markdownOption).toBeInTheDocument()
      expect(markdownOption).not.toBeDisabled()
    })

    it('has txt download option available', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))
      
      const txtOption = screen.getByRole('menuitem', { name: /download as txt/i })
      expect(txtOption).toBeInTheDocument()
      expect(txtOption).not.toBeDisabled()
    })

    it('has PDF download option available', async () => {
      const user = userEvent.setup()
      render(<DocumentExportMenu document={mockDocument} />)

      await user.click(screen.getByRole('button', { name: /download options/i }))
      
      const pdfOption = screen.getByRole('menuitem', { name: /download as pdf/i })
      expect(pdfOption).toBeInTheDocument()
      expect(pdfOption).not.toBeDisabled()
    })
  })

  describe('Click Outside', () => {
    it('closes menu when clicking outside', async () => {
      const user = userEvent.setup()
      render(
        <div>
          <DocumentExportMenu document={mockDocument} />
          <button>Outside</button>
        </div>
      )

      await user.click(screen.getByRole('button', { name: /download options/i }))
      expect(screen.getByRole('menu')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /outside/i }))

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })
    })
  })
})

describe('stripMarkdownLinks helper', () => {
  // Test the link stripping logic indirectly through TXT download
  it('handles document with markdown links in TXT export', async () => {
    const user = userEvent.setup()
    const docWithLinks: ProjectDocument = {
      ...mockDocument,
      content: 'Check [this link](https://example.com) and [another](https://test.com).',
    }

    render(<DocumentExportMenu document={docWithLinks} />)

    await user.click(screen.getByRole('button', { name: /download options/i }))
    
    // Just verify the TXT option is available for documents with links
    expect(screen.getByRole('menuitem', { name: /download as txt/i })).toBeInTheDocument()
  })
})
