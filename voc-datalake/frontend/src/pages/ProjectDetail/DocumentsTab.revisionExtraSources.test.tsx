/**
 * A revision inherits the optional inputs its base prototype was built with.
 *
 * Same defect class as the `source_prd_id` inheritance bug found in #320: without
 * inheritance the revision re-derives today's defaults, so a research report
 * created between the build and the revision silently joins it, or the
 * product-context flag is dropped — a revision that changes its inputs as well as
 * its feedback, which is not what "revise this" means.
 *
 * Every fixture therefore adds research report **B** after the base was built
 * with **A**. Only true inheritance sends A alone: re-deriving picks B (or both),
 * and a fixture with a single report could not tell the two apart.
 *
 * What is inherited is read off the base's own recorded `derivation`, which is
 * where the generator writes what it actually used.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentsTab from './DocumentsTab'
import { MAX_SELECTED_RESEARCH_IDS } from './overviewState'
import type { DocumentDerivation } from '../../api/derivation'
import type { Project, ProjectDocument } from '../../api/types'

const mockBuildPrototype = vi.fn()
vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    buildPrototype: (...args: unknown[]) => mockBuildPrototype(...args),
  },
}))

const project: Project = {
  project_id: 'proj_1',
  name: 'Test project',
  description: '',
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  persona_count: 0,
  document_count: 0,
}

function doc(overrides: Partial<ProjectDocument> & { document_id: string }): ProjectDocument {
  return {
    document_type: 'prototype',
    title: 'Prototype',
    content: '<!DOCTYPE html><html><body>x</body></html>',
    created_at: '2026-07-10T00:00:00Z',
    ...overrides,
  }
}

function derivation(overrides: Partial<DocumentDerivation>): DocumentDerivation {
  return {
    sources: [],
    selected_document_count: 0,
    feedback_count: 0,
    persona_ids: [],
    product_context_included: false,
    ...overrides,
  }
}

const RESEARCH_A = doc({
  document_id: 'research_a', document_type: 'research', title: 'Churn interviews',
  created_at: '2026-03-01T00:00:00Z',
})
/** Created AFTER the base was built. Re-deriving defaults picks this one. */
const RESEARCH_B = doc({
  document_id: 'research_b', document_type: 'research', title: 'Pricing survey',
  created_at: '2026-09-01T00:00:00Z',
})
const PRD = doc({
  document_id: 'prd_1', document_type: 'prd', title: 'Spec', created_at: '2026-01-01T00:00:00Z',
})

/** Built with product context ON and research A — and nothing else. */
const BASE = doc({
  document_id: 'proto_1',
  title: 'First cut',
  prototype_format: 'html',
  source_prd_id: 'prd_1',
  derivation: derivation({
    sources: [
      { document_id: 'prd_1', role: 'prototype_prd' },
      { document_id: 'research_a', role: 'reference' },
    ],
    selected_document_count: 2,
    product_context_included: true,
  }),
})

function renderTab(documents: ProjectDocument[], selected: ProjectDocument) {
  render(
    <DocumentsTab
      project={project}
      documents={documents}
      selectedDoc={selected}
      onSelectDoc={vi.fn()}
      onEditDoc={vi.fn()}
      onDeleteDoc={vi.fn()}
      onCreateDoc={vi.fn()}
      isDeleting={false}
    />,
  )
}

async function revise() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /revise with feedback/i }))
  await user.type(screen.getByRole('textbox'), 'Show the admin view')
  await user.click(screen.getByRole('button', { name: /^regenerate$/i }))
  await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
  return mockBuildPrototype.mock.calls[0][1]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
})

describe('a revision keeps the inputs its base was built with', () => {
  it('sends the base’s research report and not the one created since', async () => {
    renderTab([BASE, PRD, RESEARCH_A, RESEARCH_B], BASE)

    const body = await revise()

    expect(body.use_research).toBe(true)
    expect(body.selected_research_ids).toEqual(['research_a'])
  })

  it('sends the base’s product-context flag', async () => {
    renderTab([BASE, PRD, RESEARCH_A, RESEARCH_B], BASE)

    const body = await revise()

    expect(body.use_product_context).toBe(true)
  })

  it('inherits nothing from a base that used neither', async () => {
    // Research B exists and is the newest, so a re-derived default would pick it up
    // and a hardcoded `true` flag would show here.
    const plain = doc({
      document_id: 'proto_plain',
      prototype_format: 'html',
      derivation: derivation({
        sources: [{ document_id: 'prd_1', role: 'prototype_prd' }],
        selected_document_count: 1,
      }),
    })
    renderTab([plain, PRD, RESEARCH_A, RESEARCH_B], plain)

    const body = await revise()

    expect(body.use_product_context).toBe(false)
    expect(body.use_research).toBe(false)
    expect(body.selected_research_ids).toEqual([])
  })

  it('inherits nothing from a prototype built before the derivation existed', async () => {
    // `resolveDerivation` reconstructs the two source ids for such a document from
    // its legacy fields and records nothing else, so the revision behaves exactly
    // as it did before this feature.
    const legacy = doc({
      document_id: 'proto_legacy', prototype_format: 'html', source_prd_id: 'prd_1',
    })
    renderTab([legacy, PRD, RESEARCH_A, RESEARCH_B], legacy)

    const body = await revise()

    expect(body.source_prd_id).toBe('prd_1')
    expect(body.use_product_context).toBe(false)
    expect(body.selected_research_ids).toEqual([])
  })

  it('drops an inherited report that has since been deleted', async () => {
    // The API rejects an id it cannot resolve, so keeping it would turn someone
    // else's deletion into this revision's 4xx and the prototype could never be
    // revised again — the same fallback the source ids take, per slot.
    renderTab([BASE, PRD, RESEARCH_B], BASE)

    const body = await revise()

    expect(body.selected_research_ids).toEqual([])
    expect(body.use_research).toBe(false)
    // The rest of the inheritance survives one missing report.
    expect(body.use_product_context).toBe(true)
    expect(body.source_prd_id).toBe('prd_1')
  })

  it('still revises a base carrying more reports than the current bound allows', async () => {
    // Today unreachable: the API capped the base build that recorded these, so an
    // inherited list cannot exceed the bound. It becomes reachable the day the
    // bound is LOWERED, and then every prototype built under the old one is
    // un-revisable — a 400 naming a list length the user never chose and cannot
    // shorten from this button. The fixture is built one over the live bound so it
    // keeps testing that whatever the number becomes.
    const extra = Array.from({ length: MAX_SELECTED_RESEARCH_IDS + 1 }, (_, i) => `research_over_${i}`)
    const overBound = doc({
      document_id: 'proto_over',
      prototype_format: 'html',
      derivation: derivation({
        sources: extra.map((document_id) => ({ document_id, role: 'reference' as const })),
        selected_document_count: extra.length,
      }),
    })
    const reports = extra.map((id) => doc({
      document_id: id, document_type: 'research', title: id, created_at: '2026-03-01T00:00:00Z',
    }))
    renderTab([overBound, PRD, ...reports], overBound)

    const body = await revise()

    // Sliced, not truncated arbitrarily: the first N in recorded order, which is
    // the order the original build read them in.
    expect(body.selected_research_ids).toEqual(extra.slice(0, MAX_SELECTED_RESEARCH_IDS))
    expect(body.use_research).toBe(true)
  })

  it('inherits only research, never another document type recorded as a reference', async () => {
    // The scoping property, on the read side: a reference-role source that is not
    // research must not be offered to a research-only field, which the API would
    // reject under its `RESEARCH#` prefix. The base names a PRD as a reference,
    // which is the only fixture that fails if the type filter is dropped.
    const mixed = doc({
      document_id: 'proto_mixed',
      prototype_format: 'html',
      derivation: derivation({
        sources: [
          { document_id: 'prd_1', role: 'reference' },
          { document_id: 'research_a', role: 'reference' },
        ],
        selected_document_count: 2,
      }),
    })
    renderTab([mixed, PRD, RESEARCH_A, RESEARCH_B], mixed)

    const body = await revise()

    expect(body.selected_research_ids).toEqual(['research_a'])
  })
})
