/**
 * Acceptance criterion 5: the Export card's document picker renders no row for
 * a `prototype` document, and renders rows for the five exportable types
 * (prd, prfaq, research, custom, product_report).
 *
 * This test file specifically covers the export-filter behaviour so a revert of
 * the filterExportableDocs change fails here with a clear message.
 *
 * NOTE: picker sections start collapsed (expandedSections = new Set()).
 * PickerSection only renders its children when expanded. Tests that assert row
 * presence/absence must either:
 *   (a) expand the documents section first (expandDocuments(), which clicks it by role), or
 *   (b) assert on the section *header* being absent/present (when filterExportableDocs
 *       produces 0 docs, SharedPickers returns null so the header is never rendered).
 * Asserting on row text without expanding is vacuous — the rows are absent whether
 * or not the filter is applied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

/**
 * Expand the documents picker section. Found by ROLE, not by text: if the header
 * stops being a button this fails for the right reason instead of clicking a
 * non-interactive node and silently proving nothing.
 */
async function expandDocuments(): Promise<void> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /Documents \(/ }))
}

describe('McpAccessTab — export picker excludes non-exportable document types', () => {
  it('does not render a row for a prototype document — section header absent when prototype is only doc', () => {
    // filterExportableDocs([prototype]) == [] → SharedPickers returns null → no header
    renderTab([makeDoc('d-proto', 'prototype', 'A Secret Prototype')])
    // Section header would be "Documents (0/0)" if rendered, but SharedPickers returns null entirely
    expect(screen.queryByText(/Documents \(/)).not.toBeInTheDocument()
  })

  it('renders a row for a product_report document when section is expanded', async () => {
    // product_report is an exportable type — it must appear in the picker
    renderTab([makeDoc('d-report', 'product_report', 'Q4 Product Report')])
    await expandDocuments()
    expect(screen.getByText('Q4 Product Report')).toBeInTheDocument()
  })

  it('renders rows for all five exportable types when section is expanded', async () => {
    renderTab(allSixDocTypes)

    await expandDocuments()

    expect(screen.getByText('My PRD')).toBeInTheDocument()
    expect(screen.getByText('My PR/FAQ')).toBeInTheDocument()
    expect(screen.getByText('My Research')).toBeInTheDocument()
    expect(screen.getByText('My Custom Doc')).toBeInTheDocument()
    expect(screen.getByText('Q4 Product Report')).toBeInTheDocument()
  })

  it('does not render a row for prototype even when it is the only document — section absent', () => {
    // Prototype-only project: filterExportableDocs == [] → SharedPickers returns null
    renderTab([makeDoc('d-proto', 'prototype', 'Only Prototype')])
    expect(screen.queryByText(/Documents \(/)).not.toBeInTheDocument()
  })

  it('renders product_report row but not prototype row when section is expanded (mixed types)', async () => {
    renderTab(allSixDocTypes)
    await expandDocuments()
    // product_report is exportable — must be visible
    expect(screen.getByText('Q4 Product Report')).toBeInTheDocument()
    // prototype is excluded — must be absent from the rows
    expect(screen.queryByText('A Secret Prototype')).not.toBeInTheDocument()
  })

  it('prototype does not appear under any group heading — section absent when prototype is only doc', () => {
    // Before the fix, prototypes were coerced into the "custom" bucket.
    // After the fix they are excluded entirely — filterExportableDocs([prototype]) == []
    // so SharedPickers returns null, and no section header or rows appear.
    renderTab([makeDoc('d-proto', 'prototype', 'Prototype That Looked Custom')])
    expect(screen.queryByText(/Documents \(/)).not.toBeInTheDocument()
  })
})
