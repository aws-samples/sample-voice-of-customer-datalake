/**
 * The Documents tab states what the selected document was built from.
 *
 * Fixtures are chosen so no assertion here can pass by accident: the truncated
 * record names more documents selected than used, one source is absent from the
 * document list, one document carries no `derivation` field at all (so the
 * reconstruction path is exercised through the UI), and one has no recoverable
 * provenance at all.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import DocumentsTab from './DocumentsTab'
import type { DocumentDerivation } from '../../api/derivation'
import type { ProjectDocument, Project } from '../../api/types'

const project: Project = {
  project_id: 'proj-1',
  name: 'Test Project',
  description: '',
  status: 'active',
  created_at: '2026-01-05T00:00:00Z',
  updated_at: '2026-01-05T00:00:00Z',
  persona_count: 0,
  document_count: 0,
}

function makeDoc(overrides: Partial<ProjectDocument> & Pick<ProjectDocument, 'document_id'>): ProjectDocument {
  return {
    document_type: 'prd',
    title: `Title of ${overrides.document_id}`,
    content: 'Body',
    created_at: '2026-01-05T00:00:00Z',
    ...overrides,
  }
}

function derivation(overrides: Partial<DocumentDerivation> = {}): DocumentDerivation {
  return {
    sources: [],
    selected_document_count: 0,
    feedback_count: 0,
    persona_ids: [],
    product_context_included: false,
    ...overrides,
  }
}

const REFERENCE_PRFAQ = makeDoc({
  document_id: 'prfaq_1',
  document_type: 'prfaq',
  title: 'Onboarding PR/FAQ',
})

const REFERENCE_RESEARCH = makeDoc({
  document_id: 'research_1',
  document_type: 'research',
  title: 'Churn research',
})

/** Five reference documents selected, three fed to the model, one since deleted. */
const TRUNCATED_PRD = makeDoc({
  document_id: 'prd_truncated',
  title: 'PRD from five references',
  derivation: derivation({
    sources: [
      { document_id: 'prfaq_1', role: 'reference' },
      { document_id: 'research_1', role: 'reference' },
      { document_id: 'deleted_1', role: 'reference' },
    ],
    selected_document_count: 5,
    feedback_count: 12,
    persona_ids: ['persona_1', 'persona_2'],
    product_context_included: true,
  }),
})

/** Nothing dropped: as many sources as documents selected. */
const EXACT_PRD = makeDoc({
  document_id: 'prd_exact',
  title: 'PRD from one reference',
  derivation: derivation({
    sources: [{ document_id: 'prfaq_1', role: 'reference' }],
    selected_document_count: 1,
  }),
})

/** Pre-`derivation` prototype: only the old fixed-arity lineage fields. */
const LEGACY_PROTOTYPE = makeDoc({
  document_id: 'proto_legacy',
  document_type: 'prototype',
  title: 'Legacy prototype',
  content: '{}',
  source_prfaq_id: 'prfaq_1',
})

/** Hand-authored: no derivation, no legacy lineage, nothing to reconstruct. */
const HAND_AUTHORED = makeDoc({ document_id: 'custom_1', document_type: 'custom', title: 'Hand written' })

const ALL_DOCUMENTS = [TRUNCATED_PRD, EXACT_PRD, LEGACY_PROTOTYPE, HAND_AUTHORED, REFERENCE_PRFAQ, REFERENCE_RESEARCH]

function renderTab(selectedDoc: ProjectDocument, onSelectDoc = vi.fn()) {
  render(
    <MemoryRouter>
      <DocumentsTab
        project={project}
        documents={ALL_DOCUMENTS}
        selectedDoc={selectedDoc}
        onSelectDoc={onSelectDoc}
        onEditDoc={vi.fn()}
        onDeleteDoc={vi.fn()}
        onCreateDoc={vi.fn()}
        isDeleting={false}
      />
    </MemoryRouter>,
  )
  return { onSelectDoc }
}

const provenance = () => screen.getByTestId('document-derivation')

describe('the provenance of the selected document', () => {
  it('names each contributing document with its type, its title and its role', () => {
    renderTab(TRUNCATED_PRD)
    const panel = provenance()
    expect(within(panel).getByText('Built from')).toBeInTheDocument()
    expect(within(panel).getByText('Onboarding PR/FAQ')).toBeInTheDocument()
    expect(within(panel).getByText('Churn research')).toBeInTheDocument()
    expect(within(panel).getAllByText('Reference')).toHaveLength(3)
  })

  it('shows what kind of document each source is, not just the role it played', () => {
    // The badge is keyed on the source's document_type, which the resolver now
    // returns: 'reference' says how it contributed, 'PRFAQ' says what it is.
    renderTab(TRUNCATED_PRD)
    const panel = provenance()
    expect(within(panel).getByText('PRFAQ')).toBeInTheDocument()
    expect(within(panel).getByText('RESEARCH')).toBeInTheDocument()
  })

  it('states the non-document inputs, so a document generated from feedback is not built from nothing', () => {
    renderTab(TRUNCATED_PRD)
    const panel = provenance()
    expect(within(panel).getByText(/12 feedback items used/)).toBeInTheDocument()
    expect(within(panel).getByText(/2 personas used/)).toBeInTheDocument()
    expect(within(panel).getByText(/Product context included/)).toBeInTheDocument()
  })

  it('opens a source that still exists when it is clicked', async () => {
    const user = userEvent.setup()
    const { onSelectDoc } = renderTab(TRUNCATED_PRD)
    await user.click(within(provenance()).getByRole('button', { name: /Onboarding PR\/FAQ/ }))
    expect(onSelectDoc).toHaveBeenCalledWith(REFERENCE_PRFAQ)
  })

  it('shows a source deleted since as plain text, never as a control', () => {
    renderTab(TRUNCATED_PRD)
    const panel = provenance()
    // Visible: the relation outlived its target.
    expect(within(panel).getByText('deleted_1')).toBeInTheDocument()
    expect(within(panel).getByText('No longer available')).toBeInTheDocument()
    // Not navigable: every button in the panel is one of the two live sources.
    const names = within(panel).getAllByRole('button').map((b) => b.textContent ?? '')
    expect(names).toHaveLength(2)
    expect(names.some((n) => n.includes('deleted_1'))).toBe(false)
  })
})

describe('the difference between documents selected and documents used', () => {
  it('states both numbers when the generator used fewer than were selected', () => {
    renderTab(TRUNCATED_PRD)
    expect(within(provenance()).getByText('3 of 5 selected documents used')).toBeInTheDocument()
  })

  it('says nothing at all when the two numbers agree', () => {
    renderTab(EXACT_PRD)
    expect(within(provenance()).queryByText(/selected documents used/)).not.toBeInTheDocument()
  })

  it('reads as neutral information: no warning colour and no icon', () => {
    renderTab(TRUNCATED_PRD)
    const panel = provenance()
    const line = within(panel).getByText('3 of 5 selected documents used')
    // The cap is deliberate. Nothing from the line up to the panel may style it
    // as a fault, and the panel carries no icon that would imply one.
    for (let node: HTMLElement | null = line; node !== null && node !== panel.parentElement; node = node.parentElement) {
      expect(node.className).not.toMatch(/red|amber|yellow|orange/)
    }
    expect(panel.querySelectorAll('svg')).toHaveLength(0)
  })
})

describe('a document written before the derivation field existed', () => {
  it('still says what it was built from, reconstructed from its old lineage fields', () => {
    renderTab(LEGACY_PROTOTYPE)
    const panel = provenance()
    expect(within(panel).getByText('Onboarding PR/FAQ')).toBeInTheDocument()
    expect(within(panel).getByText('Prototype source PR/FAQ')).toBeInTheDocument()
    // Legacy records cannot tell used from requested, so there is no drop to report.
    expect(within(panel).queryByText(/selected documents used/)).not.toBeInTheDocument()
  })
})

describe('a document with no recoverable provenance', () => {
  it('renders nothing at all — no panel, no placeholder', () => {
    renderTab(HAND_AUTHORED)
    expect(screen.queryByTestId('document-derivation')).not.toBeInTheDocument()
    expect(screen.queryByText('Built from')).not.toBeInTheDocument()
  })

  it.each([
    ['a null derivation', null],
    ['an empty derivation', derivation()],
  ])('renders nothing for %s', (_case, value) => {
    renderTab(makeDoc({ document_id: 'sparse_1', title: 'Sparse', derivation: value }))
    expect(screen.queryByTestId('document-derivation')).not.toBeInTheDocument()
  })
})

describe('a sparse derivation record', () => {
  it('costs the provenance footer only, leaving the rest of the tab intact', () => {
    // The resolver is total, so an unreadable record is not an error state —
    // the document still renders, and so do its siblings in the list.
    renderTab(makeDoc({ document_id: 'sparse_2', title: 'Sparse record', derivation: derivation() }))
    expect(screen.queryByTestId('document-derivation')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sparse record' })).toBeInTheDocument()
    expect(screen.getByText('PRD from five references')).toBeInTheDocument()
    expect(screen.getByText('Legacy prototype')).toBeInTheDocument()
  })
})
