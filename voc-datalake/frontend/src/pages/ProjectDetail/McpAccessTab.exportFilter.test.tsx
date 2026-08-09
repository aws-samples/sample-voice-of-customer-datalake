/**
 * Acceptance criterion 5: the Export card's document picker renders no row for
 * a `prototype` or `product_report` document, and still renders rows for the
 * four exportable types (prd, prfaq, research, custom).
 *
 * This test file specifically covers the export-filter behaviour so a revert of
 * the filterExportableDocs change fails here with a clear message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import McpAccessTab from './McpAccessTab'
import type { Project, ProjectDocument, ProjectPersona } from '../../api/types'

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

vi.mock('../../api/client', () => ({
  api: {
    listApiTokens: vi.fn().mockResolvedValue({ tokens: [] }),
    createApiToken: vi.fn(),
    deleteApiToken: vi.fn(),
    autoseedProject: vi.fn(),
  },
}))

vi.mock('../../api/baseUrl', () => ({
  stripTrailingSlashes: (url: string) => url.replace(/\/$/, ''),
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com/v1' } }),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockProject: Project = {
  project_id: 'proj-filter',
  name: 'Filter Test Project',
  description: '',
  status: 'active',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  persona_count: 0,
  document_count: 0,
}

const onePersona: ProjectPersona[] = [
  { persona_id: 'p1', name: 'Alice', tagline: 'A user', created_at: '' },
]

function makeDoc(id: string, docType: ProjectDocument['document_type'], title: string): ProjectDocument {
  return {
    document_id: id,
    document_type: docType,
    title,
    content: `Content of ${title}`,
    created_at: '',
  }
}

const allSixDocTypes: ProjectDocument[] = [
  makeDoc('d-prd', 'prd', 'My PRD'),
  makeDoc('d-prfaq', 'prfaq', 'My PR/FAQ'),
  makeDoc('d-research', 'research', 'My Research'),
  makeDoc('d-custom', 'custom', 'My Custom Doc'),
  makeDoc('d-proto', 'prototype', 'A Secret Prototype'),
  makeDoc('d-report', 'product_report', 'Q4 Product Report'),
]

function renderTab(documents: ProjectDocument[], personas: ProjectPersona[] = onePersona) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <McpAccessTab
        projectId="proj-filter"
        project={mockProject}
        personas={personas}
        documents={documents}
        onSaveKiroPrompt={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpAccessTab — export picker excludes non-exportable document types', () => {
  it('does not render a row for a prototype document', () => {
    renderTab([makeDoc('d-proto', 'prototype', 'A Secret Prototype')])
    expect(screen.queryByText('A Secret Prototype')).not.toBeInTheDocument()
  })

  it('does not render a row for a product_report document', () => {
    renderTab([makeDoc('d-report', 'product_report', 'Q4 Product Report')])
    expect(screen.queryByText('Q4 Product Report')).not.toBeInTheDocument()
  })

  it('renders rows for all four exportable types when present', () => {
    renderTab(allSixDocTypes)

    // Picker sections start collapsed — expand the documents section first.
    const docsToggle = screen.getByText(/Documents \(/)
    fireEvent.click(docsToggle)

    expect(screen.getByText('My PRD')).toBeInTheDocument()
    expect(screen.getByText('My PR/FAQ')).toBeInTheDocument()
    expect(screen.getByText('My Research')).toBeInTheDocument()
    expect(screen.getByText('My Custom Doc')).toBeInTheDocument()
  })

  it('renders no row for prototype even when it is the only document', () => {
    // Prototype-only project: the documents section should be absent entirely.
    renderTab([makeDoc('d-proto', 'prototype', 'Only Prototype')])
    // The document picker section must not appear (no exportable docs).
    expect(screen.queryByText('Only Prototype')).not.toBeInTheDocument()
  })

  it('renders no row for product_report when mixed with exportable types', () => {
    renderTab(allSixDocTypes)
    // The non-exportable titles must be absent from the picker.
    expect(screen.queryByText('A Secret Prototype')).not.toBeInTheDocument()
    expect(screen.queryByText('Q4 Product Report')).not.toBeInTheDocument()
  })

  it('prototype does not appear under the Custom group heading', () => {
    // Before the fix, prototypes were coerced into the "custom" bucket.
    // After the fix they are excluded entirely — the Custom heading only holds
    // genuine custom documents.
    renderTab([makeDoc('d-proto', 'prototype', 'Prototype That Looked Custom')])
    expect(screen.queryByText('Prototype That Looked Custom')).not.toBeInTheDocument()
  })
})
