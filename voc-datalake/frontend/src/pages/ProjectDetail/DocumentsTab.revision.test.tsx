/**
 * Telling same-typed documents apart, and saying what a revision revises (U25).
 *
 * Both halves come from the same live observation: a project whose Documents tab
 * showed six rows reading `PROTOTYPE · Jul 10 · Prototype`, four of them sharing a
 * date. The type badge, the date and the title were all identical, so nothing on
 * screen distinguished them — and the two fields that record which prototype
 * revises which had been written on every revision for months, arrived on every
 * project read, and were displayed nowhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentsTab from './DocumentsTab'
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

function renderTab(documents: ProjectDocument[], selected: ProjectDocument | null, onSelectDoc = vi.fn()) {
  render(
    <DocumentsTab
      project={project}
      documents={documents}
      selectedDoc={selected}
      onSelectDoc={onSelectDoc}
      onEditDoc={vi.fn()}
      onDeleteDoc={vi.fn()}
      onCreateDoc={vi.fn()}
      isDeleting={false}
    />,
  )
  return onSelectDoc
}

describe('same-typed documents are distinguishable', () => {
  it('numbers each document within its own type, oldest first', () => {
    // The real case: identical badge, identical title, same date. Only the number
    // separates them.
    renderTab([
      doc({ document_id: 'p_a', created_at: '2026-07-10T00:00:00Z' }),
      doc({ document_id: 'p_b', created_at: '2026-07-10T00:00:00Z' }),
      doc({ document_id: 'p_c', created_at: '2026-08-08T00:00:00Z' }),
    ], null)

    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    expect(screen.getByText('3 of 3')).toBeInTheDocument()
  })

  it('says nothing for a type with a single document', () => {
    // "1 of 1" would appear on every PRD in every project that has one. The number
    // only earns its space once there is something to confuse the document with.
    renderTab([
      doc({ document_id: 'prd_1', document_type: 'prd', title: 'Spec' }),
      doc({ document_id: 'prfaq_1', document_type: 'prfaq', title: 'Launch' }),
    ], null)

    expect(screen.queryByText('1 of 1')).not.toBeInTheDocument()
  })

  it('counts types separately, so one type cannot renumber another', () => {
    renderTab([
      doc({ document_id: 'prd_1', document_type: 'prd', title: 'Spec', created_at: '2026-01-01T00:00:00Z' }),
      doc({ document_id: 'prd_2', document_type: 'prd', title: 'Spec', created_at: '2026-02-01T00:00:00Z' }),
      doc({ document_id: 'p_1' }),
    ], null)

    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    expect(screen.queryByText(/of 3/)).not.toBeInTheDocument()
  })
})

describe('a revision says what it revises', () => {
  const base = doc({ document_id: 'proto_1', title: 'First cut', created_at: '2026-08-01T00:00:00Z' })
  const revision = doc({
    document_id: 'proto_2',
    title: 'First cut',
    created_at: '2026-08-08T00:00:00Z',
    revised_from_id: 'proto_1',
    revision_feedback: 'Show the admin perspective',
  })

  it('names the prototype it was revised from, and the feedback that drove it', () => {
    renderTab([base, revision], revision)

    const panel = screen.getByTestId('document-revision')
    expect(panel).toHaveTextContent('Revision of')
    expect(panel).toHaveTextContent('First cut')
    expect(panel).toHaveTextContent('Show the admin perspective')
  })

  it('opens the revised document when its name is clicked', async () => {
    const user = userEvent.setup()
    const onSelectDoc = renderTab([base, revision], revision)

    await user.click(within(screen.getByTestId('document-revision')).getByRole('button'))

    expect(onSelectDoc).toHaveBeenCalledWith(base)
  })

  it('keeps the relation visible, but not clickable, once the base is deleted', () => {
    // The revision happened even though its predecessor is gone, so it is still
    // reported — as text, because a control that leads nowhere is worse than none.
    renderTab([revision], revision)

    const panel = screen.getByTestId('document-revision')
    expect(panel).toHaveTextContent('proto_1')
    expect(panel).toHaveTextContent(/No longer available/i)
    expect(within(panel).queryByRole('button')).toBeNull()
  })

  it('renders nothing for a document that is not a revision', () => {
    renderTab([base, revision], base)

    expect(screen.queryByTestId('document-revision')).not.toBeInTheDocument()
  })

  it('reports a revision that recorded no feedback without an empty line', () => {
    renderTab([base, doc({ document_id: 'proto_3', revised_from_id: 'proto_1' })],
      doc({ document_id: 'proto_3', revised_from_id: 'proto_1' }))

    const panel = screen.getByTestId('document-revision')
    expect(panel).toHaveTextContent('Revision of')
    expect(panel).not.toHaveTextContent(/Feedback:/)
  })

  it('treats a stored null exactly like an absent field', () => {
    // The backend writes `revised_from_id: base_prototype_id or None`, so null is a
    // real stored value on any revision started with no base.
    renderTab([doc({ document_id: 'proto_9', revised_from_id: null })],
      doc({ document_id: 'proto_9', revised_from_id: null }))

    expect(screen.queryByTestId('document-revision')).not.toBeInTheDocument()
  })
})

describe('revising a prototype keeps the spec it was built from', () => {
  const built = doc({
    document_id: 'proto_1',
    title: 'First cut',
    prototype_format: 'html',
    source_prd_id: 'prd_june',
    source_prfaq_id: 'prfaq_june',
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
  })

  it('sends the base prototype’s own sources, not whatever is newest', async () => {
    // Without this the backend re-resolves "the newest of each type", so revising a
    // prototype built from June's PRD would quietly re-base it on September's — a
    // revision that changes the spec as well as the feedback. The project holds a
    // newer PRD precisely so a regression has something wrong to pick.
    const user = userEvent.setup()
    // Both inherited sources must be PRESENT in the project: since review round 1
    // an id that no longer resolves is dropped to '', so a fixture that omits the
    // PR/FAQ it claims is inherited would assert the fallback, not the inheritance.
    renderTab([
      built,
      doc({ document_id: 'prd_june', document_type: 'prd', title: 'June spec', created_at: '2026-06-01T00:00:00Z' }),
      doc({ document_id: 'prd_sept', document_type: 'prd', title: 'September spec', created_at: '2026-09-01T00:00:00Z' }),
      doc({ document_id: 'prfaq_june', document_type: 'prfaq', title: 'June launch', created_at: '2026-06-01T00:00:00Z' }),
    ], built)

    await user.click(screen.getByRole('button', { name: /revise with feedback/i }))
    await user.type(screen.getByRole('textbox'), 'Show the admin view')
    await user.click(screen.getByRole('button', { name: /^regenerate$/i }))

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    const body = mockBuildPrototype.mock.calls[0][1]
    expect(body.source_prd_id).toBe('prd_june')
    expect(body.source_prfaq_id).toBe('prfaq_june')
    expect(body.base_prototype_id).toBe('proto_1')
  })

  it('falls back to blank for a prototype that recorded no source', async () => {
    // Pre-lineage prototypes stored a real null. Blank is what the API reads as
    // "not aimed", which restores the old newest-of-each behaviour for them rather
    // than sending a null the validator would reject.
    const user = userEvent.setup()
    const legacy = doc({ document_id: 'proto_legacy', prototype_format: 'html', source_prd_id: null })
    renderTab([legacy], legacy)

    await user.click(screen.getByRole('button', { name: /revise with feedback/i }))
    await user.type(screen.getByRole('textbox'), 'Any change')
    await user.click(screen.getByRole('button', { name: /^regenerate$/i }))

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    const body = mockBuildPrototype.mock.calls[0][1]
    expect(body.source_prd_id).toBe('')
    expect(body.source_prfaq_id).toBe('')
  })
})

describe('a prototype stays revisable after its source is deleted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
  })

  it('drops an inherited source id that is no longer in the project', async () => {
    // Found in review round 1 on PR #320. Inheriting the base prototype's sources
    // keeps a revision on the same spec — but the API refuses an id it cannot
    // resolve, so a prototype whose PRD was deleted afterwards would send a dead
    // id on every attempt and could never be revised again. Blank instead: the
    // document whose spec would have been preserved no longer exists, so
    // newest-of-type is the only thing left, and it is not a silent substitution.
    const user = userEvent.setup()
    const orphaned = doc({
      document_id: 'proto_orphan',
      prototype_format: 'html',
      source_prd_id: 'prd_deleted_since',
      source_prfaq_id: 'prfaq_still_here',
    })
    renderTab([
      orphaned,
      doc({ document_id: 'prfaq_still_here', document_type: 'prfaq', title: 'Launch note' }),
    ], orphaned)

    await user.click(screen.getByRole('button', { name: /revise with feedback/i }))
    await user.type(screen.getByRole('textbox'), 'Any change')
    await user.click(screen.getByRole('button', { name: /^regenerate$/i }))

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    const body = mockBuildPrototype.mock.calls[0][1]
    expect(body.source_prd_id).toBe('')
    // The one that DOES still exist is still inherited — the fallback is per slot,
    // not all-or-nothing, so a deleted PRD does not also discard a live PR/FAQ.
    expect(body.source_prfaq_id).toBe('prfaq_still_here')
  })
})
