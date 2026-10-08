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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  PROTOTYPE_PROJECT, prototypeDoc as doc, prototypeProjectsApiModule,
  resetPrototypeMocks, reviseWithFeedback,
} from './prototype-fixtures'
import { documentsTabStubs } from './project-detail-fixtures'
// After the fixtures on purpose: this imports DocumentsTab, whose module graph runs
// the `vi.mock` factory below, which needs the fixture module evaluated.
import DocumentsTab from './DocumentsTab'
import type { ProjectDocument } from '../../api/types'

vi.mock('../../api/projectsApi', () => prototypeProjectsApiModule())

function renderTab(documents: ProjectDocument[], selected: ProjectDocument | null, onSelectDoc = vi.fn()) {
  render(
    <DocumentsTab
      project={PROTOTYPE_PROJECT}
      documents={documents}
      selectedDoc={selected}
      onSelectDoc={onSelectDoc}
      {...documentsTabStubs()}
    />,
  )
  return onSelectDoc
}

describe('document list disambiguation', () => {
  it('shows canonical prototype titles without contextual ordinals', () => {
    renderTab([
      doc({ document_id: 'p_1', title: 'Checkout prototype (v1)', version: 1 }),
      doc({ document_id: 'p_2', title: 'Checkout prototype (v2)', version: 2 }),
    ], null)

    expect(screen.getByRole('button', { name: /Checkout prototype \(v1\)/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Checkout prototype \(v2\)/ })).toBeInTheDocument()
    expect(screen.queryByText(/of 2/)).not.toBeInTheDocument()
  })

  it('numbers unmanaged documents of one type oldest first', () => {
    renderTab([
      doc({ document_id: 'custom_b', document_type: 'custom', title: 'Notes', created_at: '2026-02-01T00:00:00Z' }),
      doc({ document_id: 'custom_a', document_type: 'custom', title: 'Notes', created_at: '2026-01-01T00:00:00Z' }),
    ], null)

    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
  })

  it('keeps unmanaged type sequences independent', () => {
    renderTab([
      doc({ document_id: 'custom_1', document_type: 'custom', title: 'Notes' }),
      doc({ document_id: 'custom_2', document_type: 'custom', title: 'Notes' }),
      doc({ document_id: 'research_1', document_type: 'research', title: 'Research' }),
    ], null)

    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    expect(screen.queryByText('1 of 1')).not.toBeInTheDocument()
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

  beforeEach(resetPrototypeMocks)

  it('sends the base prototype’s own sources, not whatever is newest', async () => {
    // Without this the backend re-resolves "the newest of each type", so revising a
    // prototype built from June's PRD would quietly re-base it on September's — a
    // revision that changes the spec as well as the feedback. The project holds a
    // newer PRD precisely so a regression has something wrong to pick.
    // Both inherited sources must be PRESENT in the project: since review round 1
    // an id that no longer resolves is dropped to '', so a fixture that omits the
    // PR/FAQ it claims is inherited would assert the fallback, not the inheritance.
    renderTab([
      built,
      doc({ document_id: 'prd_june', document_type: 'prd', title: 'June spec', created_at: '2026-06-01T00:00:00Z' }),
      doc({ document_id: 'prd_sept', document_type: 'prd', title: 'September spec', created_at: '2026-09-01T00:00:00Z' }),
      doc({ document_id: 'prfaq_june', document_type: 'prfaq', title: 'June launch', created_at: '2026-06-01T00:00:00Z' }),
    ], built)

    const body = await reviseWithFeedback('Show the admin view')
    expect(body.source_prd_id).toBe('prd_june')
    expect(body.source_prfaq_id).toBe('prfaq_june')
    expect(body.base_prototype_id).toBe('proto_1')
  })

  it('falls back to blank for a prototype that recorded no source', async () => {
    // Pre-lineage prototypes stored a real null. Blank is what the API reads as
    // "not aimed", which restores the old newest-of-each behaviour for them rather
    // than sending a null the validator would reject.
    const legacy = doc({ document_id: 'proto_legacy', prototype_format: 'html', source_prd_id: null })
    renderTab([legacy], legacy)

    const body = await reviseWithFeedback('Any change')
    expect(body.source_prd_id).toBe('')
    expect(body.source_prfaq_id).toBe('')
  })
})

describe('a prototype stays revisable after its source is deleted', () => {
  beforeEach(resetPrototypeMocks)

  it('drops an inherited source id that is no longer in the project', async () => {
    // Found in review round 1 on PR #320. Inheriting the base prototype's sources
    // keeps a revision on the same spec — but the API refuses an id it cannot
    // resolve, so a prototype whose PRD was deleted afterwards would send a dead
    // id on every attempt and could never be revised again. Blank instead: the
    // document whose spec would have been preserved no longer exists, so
    // newest-of-type is the only thing left, and it is not a silent substitution.
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

    const body = await reviseWithFeedback('Any change')
    expect(body.source_prd_id).toBe('')
    // The one that DOES still exist is still inherited — the fallback is per slot,
    // not all-or-nothing, so a deleted PRD does not also discard a live PR/FAQ.
    expect(body.source_prfaq_id).toBe('prfaq_still_here')
  })

  it('says so, rather than re-basing the revision silently', async () => {
    // Review round 2: the fallback is justified, but an unexplained change of spec
    // is the behaviour this whole flow exists to remove. So the panel says it.
    const user = userEvent.setup()
    const orphaned = doc({
      document_id: 'proto_orphan',
      prototype_format: 'html',
      source_prd_id: 'prd_deleted_since',
    })
    renderTab([orphaned], orphaned)

    await user.click(screen.getByRole('button', { name: /revise with feedback/i }))

    expect(screen.getByTestId('revision-rebased-note')).toHaveTextContent(/no longer exists/i)
  })

  it('says nothing when every inherited source is still present', async () => {
    const user = userEvent.setup()
    const intact = doc({
      document_id: 'proto_intact',
      prototype_format: 'html',
      source_prd_id: 'prd_here',
    })
    renderTab([intact, doc({ document_id: 'prd_here', document_type: 'prd', title: 'Spec' })], intact)

    await user.click(screen.getByRole('button', { name: /revise with feedback/i }))

    expect(screen.queryByTestId('revision-rebased-note')).not.toBeInTheDocument()
  })
})
