/**
 * Choosing which documents a prototype is built from (U25).
 *
 * The defect: with three PR/FAQs the build read whichever was newest, two were
 * unreachable, and the choice changed under the user whenever a new document was
 * saved. The footer added by #317 reported the source only afterwards.
 *
 * Every fixture here holds TWO documents of a type on purpose. A one-of-each
 * project cannot tell "sent the document the dialog showed" apart from "sent
 * whatever there was", which is the whole question.
 *
 * `t()` resolves against the real en catalogue (src/test/setup.ts), so a key that
 * moved echoes its raw path and these matchers fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OverviewTab from './OverviewTab'
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

function doc(
  documentType: ProjectDocument['document_type'],
  id: string,
  title: string,
  createdAt: string,
): ProjectDocument {
  return { document_id: id, document_type: documentType, title, content: 'x', created_at: createdAt }
}

// Ids deliberately out of creation order, so a default that ranked by id rather
// than by date would pick the older document.
const PRD_OLD = doc('prd', 'zz_prd_old', 'Delivery spec', '2026-01-01T00:00:00Z')
const PRD_NEW = doc('prd', 'aa_prd_new', 'Delivery spec v2', '2026-06-01T00:00:00Z')
const PRFAQ = doc('prfaq', 'prfaq_1', 'Launch note', '2026-02-01T00:00:00Z')

function renderTab(documents: ProjectDocument[]) {
  return render(
    <OverviewTab
      project={project}
      personas={[]}
      documents={documents}
      onGeneratePersonas={vi.fn()}
      onGenerateDoc={vi.fn()}
      onRunResearch={vi.fn()}
      onRemixDocuments={vi.fn()}
      onOpenProductTool={vi.fn()}
      onJobStarted={vi.fn()}
    />,
  )
}

const buildButton = () => screen.getByRole('button', { name: /build prototype/i })
const confirmButton = () => screen.getByRole('button', { name: /build anyway/i })
const sentBody = () => mockBuildPrototype.mock.calls[0][1]

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildPrototype.mockResolvedValue({ job_id: 'job_1' })
})

describe('the source picker appears only when there is a choice', () => {
  it('stops to ask when a type has more than one document', async () => {
    const user = userEvent.setup()
    renderTab([PRD_OLD, PRD_NEW, PRFAQ])

    await user.click(buildButton())

    // Nothing billable before the user has seen which documents will be read.
    expect(mockBuildPrototype).not.toHaveBeenCalled()
    expect(screen.getByText(/more than one PRD or PR\/FAQ/i)).toBeInTheDocument()
    expect(screen.getByTestId('prototype-source-picker')).toBeInTheDocument()
  })

  it('does not ask when there is exactly one of each', async () => {
    // Preserved deliberately: a dialog offering a choice with one possible answer
    // is friction, and this build has started on the first click since it shipped.
    const user = userEvent.setup()
    renderTab([PRD_NEW, PRFAQ])

    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('prototype-source-picker')).not.toBeInTheDocument()
  })

  it('offers a select for the type with several and a plain line for the type with one', async () => {
    const user = userEvent.setup()
    renderTab([PRD_OLD, PRD_NEW, PRFAQ])

    await user.click(buildButton())

    expect(screen.getByRole('combobox', { name: 'PRD' })).toBeInTheDocument()
    // One PR/FAQ: still named, because "what will this read" is half the reason
    // the dialog opened — but not a control, because there is nothing to pick.
    expect(screen.queryByRole('combobox', { name: 'PR/FAQ' })).not.toBeInTheDocument()
    expect(screen.getByText('Launch note')).toBeInTheDocument()
  })

  it('still shows the picker when the more urgent rebuild warning is the message', async () => {
    // Two things are true at once: a prototype already exists AND there is a
    // choice. The costlier warning wins the sentence; the picker is not dropped.
    const user = userEvent.setup()
    renderTab([PRD_OLD, PRD_NEW, PRFAQ, doc('prototype', 'proto_1', 'Prototype', '2026-07-01T00:00:00Z')])

    await user.click(buildButton())

    expect(screen.getByText(/already has a prototype/i)).toBeInTheDocument()
    expect(screen.getByTestId('prototype-source-picker')).toBeInTheDocument()
  })
})

describe('the build reads the documents the dialog named', () => {
  it('defaults to the newest of each type, by date and not by id', async () => {
    const user = userEvent.setup()
    renderTab([PRD_OLD, PRD_NEW, PRFAQ])

    await user.click(buildButton())
    await user.click(confirmButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().source_prd_id).toBe('aa_prd_new')
    expect(sentBody().source_prfaq_id).toBe('prfaq_1')
  })

  it('sends the older document when the user picks it', async () => {
    // The feature: aim a build at an earlier spec. Nothing else in this file
    // fails if the selection is ignored and the default is sent regardless.
    const user = userEvent.setup()
    renderTab([PRD_OLD, PRD_NEW, PRFAQ])

    await user.click(buildButton())
    await user.selectOptions(screen.getByRole('combobox', { name: 'PRD' }), 'zz_prd_old')
    await user.click(confirmButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().source_prd_id).toBe('zz_prd_old')
  })

  it('names the documents even when it does not stop to ask', async () => {
    // With one of each there is no dialog, but the ids are still sent. Without
    // them the backend re-resolves "the newest" at build time, so a document
    // saved between render and click would be used instead of the one shown.
    const user = userEvent.setup()
    renderTab([PRD_NEW, PRFAQ])

    await user.click(buildButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().source_prd_id).toBe('aa_prd_new')
    expect(sentBody().source_prfaq_id).toBe('prfaq_1')
  })

  it('sends a blank id for a type the project has none of', async () => {
    // Blank is what the API reads as "not aimed"; a fabricated id would be a 404
    // and an omitted key would be a different request shape to reason about.
    const user = userEvent.setup()
    renderTab([PRD_NEW])

    await user.click(buildButton())
    await user.click(confirmButton())

    await waitFor(() => expect(mockBuildPrototype).toHaveBeenCalledTimes(1))
    expect(sentBody().source_prd_id).toBe('aa_prd_new')
    expect(sentBody().source_prfaq_id).toBe('')
  })

  it('marks which option is the one a default build would read', async () => {
    const user = userEvent.setup()
    renderTab([PRD_OLD, PRD_NEW, PRFAQ])

    await user.click(buildButton())

    // The newest is first AND says so: the ordering alone is invisible to someone
    // who did not write it.
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent(/Delivery spec v2/)
    expect(options[0]).toHaveTextContent(/latest/)
  })

  it('keeps the dialog open while the user changes their mind', async () => {
    // The dialog closes itself when the reason it opened for no longer applies, so
    // the reason must be derived from the option COUNTS and never from the
    // selection. Derived from the selection, choosing a document would dismiss the
    // dialog you chose it in — and the two tests above would still pass, because
    // both read the request rather than the screen.
    const user = userEvent.setup()
    renderTab([PRD_OLD, PRD_NEW, PRFAQ])

    await user.click(buildButton())
    await user.selectOptions(screen.getByRole('combobox', { name: 'PRD' }), 'zz_prd_old')

    expect(screen.getByTestId('prototype-source-picker')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'PRD' })).toHaveValue('zz_prd_old')
    expect(mockBuildPrototype).not.toHaveBeenCalled()
  })

  it('starts no build when the dialog is cancelled', async () => {
    const user = userEvent.setup()
    renderTab([PRD_OLD, PRD_NEW, PRFAQ])

    await user.click(buildButton())
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(mockBuildPrototype).not.toHaveBeenCalled()
    expect(screen.queryByTestId('prototype-source-picker')).not.toBeInTheDocument()
  })
})
