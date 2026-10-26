/**
 * @fileoverview Tests for DocumentExportMenu component
 * @module components/DocumentExportMenu/DocumentExportMenu.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { openExportMenu, openThenClickOutside, renderExportMenu } from '../../test/export-menu'
import DocumentExportMenu from './DocumentExportMenu'
import { exportProject, prdDocument } from './documentExport-fixtures'
import { ariaExpandedAcrossClick } from '../ExportMenuShell/exportMenu-fixtures'
import type { ProjectDocument } from '../../api/types'
import type { Project } from '../../api/projectTypes'

// Mock printUtils
const mockOpenPrintWindow = vi.fn<(options: unknown) => unknown>()
vi.mock('../../utils/printUtils', () => ({
  openPrintWindow: (options: unknown) => mockOpenPrintWindow(options),
}))

// Mock react-markdown for DocumentPDFContent
vi.mock('react-markdown', () => import('@test/markdown-mocks').then(m => m.reactMarkdownMock()))
vi.mock('remark-gfm', () => import('@test/markdown-mocks').then(m => m.remarkGfmMock()))

const mockDocument = prdDocument({
  title: 'Test PRD Document',
  content: '# Overview\n\nThis is a **test** document with [links](https://example.com).',
})

const mockProject = exportProject({
  description: 'Test description',
  persona_count: 2,
  document_count: 3,
  kiro_default_export_prompt: 'Build this feature using React and TypeScript.',
})

const TRIGGER = /download options/i

/** Mount the menu for `document` (and optionally `project`) and open it. */
function openMenu(document: ProjectDocument = mockDocument, project?: Project) {
  return openExportMenu(<DocumentExportMenu document={document} project={project} />, TRIGGER)
}

/** Assert that the menu renders nothing at all for `document`. */
function expectRendersNothing(document: ProjectDocument | null) {
  const { container } = render(<DocumentExportMenu document={document} />)
  expect(container).toBeEmptyDOMElement()
}

describe('DocumentExportMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOpenPrintWindow.mockReturnValue({ print: vi.fn() })
  })

  describe('Rendering', () => {
    it('renders menu button', () => {
      expect(renderExportMenu(<DocumentExportMenu document={mockDocument} />, TRIGGER)).toBeInTheDocument()
    })

    it('returns null when document is null', () => {
      expectRendersNothing(null)
    })

    it('menu is closed by default', () => {
      renderExportMenu(<DocumentExportMenu document={mockDocument} />, TRIGGER)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  describe('Menu Toggle', () => {
    it('opens menu when button is clicked', async () => {
      await openMenu()

      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('closes menu when button is clicked again', async () => {
      const user = await openMenu()
      expect(screen.getByRole('menu')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: TRIGGER }))
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('sets aria-expanded correctly', async () => {
      expect(await ariaExpandedAcrossClick(<DocumentExportMenu document={mockDocument} />, TRIGGER))
        .toStrictEqual({ before: 'false', after: 'true' })
    })
  })

  describe('Menu Options', () => {
    it('shows copy option', async () => {
      await openMenu()

      const copyButtons = screen.getAllByRole('menuitem').filter(el => el.textContent === 'Copy')
      expect(copyButtons.length).toBeGreaterThanOrEqual(1)
    })

    it.each([
      ['markdown', /download as markdown/i],
      ['PDF', /download as pdf/i],
      ['TXT', /download as txt/i],
    ])('shows an enabled download as %s option', async (_format, name) => {
      await openMenu()

      const option = screen.getByRole('menuitem', { name })
      expect(option).toBeInTheDocument()
      expect(option).not.toBeDisabled()
    })

    it.each([
      ['PRD', 'prd'],
      ['PRFAQ', 'prfaq'],
    ] as const)('shows copy to Kiro option for %s documents', async (_label, documentType) => {
      await openMenu({ ...mockDocument, document_type: documentType }, mockProject)

      expect(screen.getByRole('menuitem', { name: /copy to kiro/i })).toBeInTheDocument()
    })

    it('does not show copy to Kiro for research documents', async () => {
      await openMenu({ ...mockDocument, document_type: 'research' }, mockProject)

      expect(screen.queryByRole('menuitem', { name: /copy to kiro/i })).not.toBeInTheDocument()
    })
  })

  describe('Copy Action', () => {
    it('copies content to clipboard', async () => {
      const user = await openMenu()
      const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText')

      await user.click(screen.getByRole('menuitem', { name: /^copy$/i }))

      expect(writeTextSpy).toHaveBeenCalledWith(mockDocument.content)
    })

    it('shows copied feedback', async () => {
      const user = await openMenu()

      await user.click(screen.getByRole('menuitem', { name: /^copy$/i }))

      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })
  })

  describe('Copy to Kiro Action', () => {
    it('copies content with kiro prompt', async () => {
      const user = await openMenu(mockDocument, mockProject)
      const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText')

      await user.click(screen.getByRole('menuitem', { name: /copy to kiro/i }))

      expect(writeTextSpy).toHaveBeenCalledExactlyOnceWith(
        `${mockProject.kiro_default_export_prompt ?? ''}\n\n---\n\n## PRD Document\n\n# ${mockDocument.title}\n\n${mockDocument.content}`,
      )
    })
  })

  describe('Download Actions', () => {
    it('calls openPrintWindow when PDF option is clicked', async () => {
      const user = await openMenu()

      await user.click(screen.getByRole('menuitem', { name: /download as pdf/i }))

      expect(mockOpenPrintWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          title: mockDocument.title,
        })
      )
    })
  })

  describe('Click Outside', () => {
    it('closes menu when clicking outside', async () => {
      await openThenClickOutside(<DocumentExportMenu document={mockDocument} />, TRIGGER)

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })
    })
  })
})

describe('DocumentExportMenu with prototypes', () => {
  it.each([
    // New prototypes have no inline content — text export does not make sense for
    // a rendered iframe, so the menu should not render at all.
    ['a new (S3-only) prototype with prototype_url and no content', {
      document_id: 'proto-1',
      title: 'Test Prototype',
      content: '',
      prototype_url: 'https://cdn.example.com/prototypes/proj-1/proto-1.html',
    }],
    ['an inline legacy prototype without a URL', {
      document_id: 'proto-legacy-1',
      title: 'Legacy Prototype',
      content: '<!DOCTYPE html><html><body>Legacy</body></html>',
    }],
  ])('returns null for %s', (_title, fields) => {
    expectRendersNothing({
      document_type: 'prototype',
      prototype_format: 'html',
      created_at: '2025-01-01T00:00:00Z',
      ...fields,
    })
  })
})

describe('stripMarkdownLinks helper', () => {
  it('handles document with markdown links in TXT export', async () => {
    await openMenu({
      ...mockDocument,
      content: 'Check [this link](https://example.com) and [another](https://test.com).',
    })

    expect(screen.getByRole('menuitem', { name: /download as txt/i })).toBeInTheDocument()
  })
})
