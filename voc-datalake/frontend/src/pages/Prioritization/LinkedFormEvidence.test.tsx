/**
 * Tests for the collected-feedback panel on a prioritization row.
 *
 * These drive the whole page rather than the panel in isolation, because two of
 * the behaviours under test are properties of the page: which form matches which
 * row, and that no stats request is made until a row is expanded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import './prioritization-mock-fixtures'
import { prioritizationMocks, mutableConfig, project } from './prioritization-fixtures'
import { openRow, renderUntilRow, expectScoresPanelShown } from './prioritization-render-fixtures'

const prfaq = {
  document_id: 'doc_prfaq', document_type: 'prfaq', title: 'Feature A PR/FAQ',
  content: '# Feature A', created_at: '2025-01-03',
}
const prd = {
  document_id: 'doc_prd', document_type: 'prd', title: 'Feature A PRD',
  content: 'PRD content', created_at: '2025-01-02',
}

/**
 * The project's ONE row, holding both of its scorable documents.
 *
 * Which is what this file is now about: a row is a project's set of documents, and
 * each document's collected form evidence stays attached to the document it belongs
 * to INSIDE the expansion. The row is named after its newest document — the PR/FAQ
 * here — which is what `expandRow` clicks.
 */
const row = {
  row_id: 'row_p1_default',
  project_id: 'p1',
  document_ids: ['doc_prfaq', 'doc_prd'],
  prototype_id: '',
  is_default: true,
  created_at: '2025-01-03',
}

/** One feedback form, linked to the row's PR/FAQ. */
function givenOneFormLinkedToThePrfaq(formId: string, name: string) {
  prioritizationMocks.getFeedbackForms.mockResolvedValue({
    forms: [{ form_id: formId, name, project_id: 'p1', document_id: 'doc_prfaq' }],
  })
}

/**
 * The value rendered next to an evidence metric's label. Reads the sibling of
 * the label node, so the assertion is about that metric rather than about any
 * text anywhere on the page.
 */
function readMetricValue(label: string): string | null {
  const labelNode = screen.getByText(label)
  return labelNode.parentElement?.firstElementChild?.textContent ?? null
}

const { t } = i18n

/** Open the PR/FAQ row and wait until the linked form `name` is on screen. */
async function openRowShowingTheForm(name: string) {
  const user = await openRow('Feature A PR/FAQ')
  await waitFor(() => {
    expect(screen.getByText(name)).toBeInTheDocument()
  })
  return user
}

/** How assistive technology names the QR of one form — the QR carries no text. */
function qrName(formName: string): string {
  return t('components:formQrCode.accessibleName', { formName })
}

/** Link the concept test to the PR/FAQ and open the row until the form is on screen. */
function openRowShowingTheConceptTest() {
  givenOneFormLinkedToThePrfaq('form_1', 'PR/FAQ concept test')
  return openRowShowingTheForm('PR/FAQ concept test')
}

/** "12 submissions, average 3.2" — the count and the average the row shipped with. */
function expectShippedCountAndAverage() {
  expect(screen.getByText('12')).toBeInTheDocument()
  expect(screen.getByText('3.2')).toBeInTheDocument()
}

/** A form linked to the PR/FAQ whose stats read answers that it no longer exists. */
function givenTheLinkedFormIsGone() {
  givenOneFormLinkedToThePrfaq('form_gone', 'Deleted form')
  prioritizationMocks.getFeedbackFormStats.mockRejectedValue(new Error('Form not found'))
}

async function expectEvidenceUnavailable() {
  await waitFor(() => {
    expect(screen.getByText(t('prioritization:evidence.unavailable'))).toBeInTheDocument()
  })
}

describe('collected feedback on a prioritization row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mutableConfig.apiEndpoint = 'https://api.example.com'
    prioritizationMocks.getProjects.mockResolvedValue({ projects: [project] })
    prioritizationMocks.getProject.mockResolvedValue({ project_id: 'p1', documents: [prfaq, prd] })
    prioritizationMocks.getPrioritizationScores.mockResolvedValue({ scores: {}, rows: { [row.row_id]: row } })
    prioritizationMocks.createPrioritizationRow.mockResolvedValue({ success: true, created: false, row })
    prioritizationMocks.getFeedbackForms.mockResolvedValue({ forms: [] })
    prioritizationMocks.getFeedbackFormStats.mockResolvedValue({
      success: true, form_id: 'form_1',
      stats: { total_submissions: 12, avg_rating: 3.2, rating_count: 10 },
    })
  })

  it('shows the submission count and average rating of the form linked to the row', async () => {
    await openRowShowingTheConceptTest()

    // The end state the change exists for: "12 submissions, average 3.2" on the
    // row being scored.
    expectShippedCountAndAverage()
    expect(prioritizationMocks.getFeedbackFormStats).toHaveBeenCalledWith('form_1')
  })

  it('says so when no form is linked to the row', async () => {
    prioritizationMocks.getFeedbackForms.mockResolvedValue({
      // A standalone website survey: linked to nothing, so it belongs to no row.
      forms: [{ form_id: 'form_9', name: 'Website Footer Form' }],
    })

    await openRow('Feature A PR/FAQ')

    // ONCE PER DOCUMENT the row holds, because evidence is per document: the row
    // carries a PR/FAQ and a PRD, and each says for itself that nothing validates
    // it. One shared "no forms" line for the row would hide which document the
    // gap is on, which is the thing a reader would act on.
    await waitFor(() => {
      expect(screen.getAllByText(t('prioritization:evidence.noLinkedForm'))).toHaveLength(2)
    })
    expect(screen.queryByText('Website Footer Form')).not.toBeInTheDocument()
    // And no money is spent on stats for a row with nothing to show.
    expect(prioritizationMocks.getFeedbackFormStats).not.toHaveBeenCalled()
  })

  it('renders a null average as no ratings, never as zero', async () => {
    // What a ratings-disabled form actually returns: submissions but no average.
    givenOneFormLinkedToThePrfaq('form_1', 'Text-only form')
    prioritizationMocks.getFeedbackFormStats.mockResolvedValue({
      success: true, form_id: 'form_1',
      stats: { total_submissions: 7, avg_rating: null, rating_count: 0 },
    })

    await openRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText(t('prioritization:evidence.noRatings'))).toBeInTheDocument()
    })
    expect(screen.getByText('7')).toBeInTheDocument()
    // A 0 or 0.0 here would read as unanimously terrible feedback. Read the
    // rendered value out of the average metric itself rather than searching the
    // page, which also contains the "0 High Priority" stats cards.
    expect(readMetricValue(t('prioritization:evidence.avgRating'))).toBe('—')
  })

  it('shows every form validating the same document', async () => {
    prioritizationMocks.getFeedbackForms.mockResolvedValue({
      forms: [
        { form_id: 'form_1', name: 'Concept test', project_id: 'p1', document_id: 'doc_prfaq' },
        { form_id: 'form_2', name: 'Pricing test', project_id: 'p1', document_id: 'doc_prfaq' },
      ],
    })

    await openRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText('Concept test')).toBeInTheDocument()
    })
    expect(screen.getByText('Pricing test')).toBeInTheDocument()
  })

  it('still shows a project\'s evidence after its document was regenerated', async () => {
    prioritizationMocks.getFeedbackForms.mockResolvedValue({
      // doc_v1 no longer exists — regenerating minted doc_prfaq.
      forms: [{ form_id: 'form_1', name: 'Concept test', project_id: 'p1', document_id: 'doc_v1' }],
    })

    await openRow('Feature A PR/FAQ')

    // A form whose stored document id names nothing live falls back to the PROJECT,
    // so it surfaces under every document of that project's row rather than being
    // lost. Two here, one per document — the fallback is deliberately project-wide,
    // which is what keeps the collected ratings visible at all after a regenerate.
    await waitFor(() => {
      expect(screen.getAllByText('Concept test')).toHaveLength(2)
    })
    // Twice, once per document, matching the panel count above: pinning the exact
    // number is what fails if the fallback stops fanning out, where "at least one"
    // passes on a single panel and so cannot tell the two apart.
    expect(screen.getAllByText('3.2')).toHaveLength(2)
  })

  it('degrades gracefully when a linked form no longer exists', async () => {
    givenTheLinkedFormIsGone()

    await openRow('Feature A PR/FAQ')

    await expectEvidenceUnavailable()
  })

  it('fetches stats for every document of the expanded row, and no other row', async () => {
    // The bound is the EXPANSION, not the document: one expanded row shows each of
    // its documents with that document's own evidence, so both of this row's forms
    // are fetched. What must not happen is a page of rows fanning out on load —
    // the stats endpoint scans a whole brand-wide partition per call — so the
    // second project's form is the one that stays unfetched.
    prioritizationMocks.getProjects.mockResolvedValue({ projects: [project, { ...project, project_id: 'p2', name: 'Project 2' }] })
    prioritizationMocks.getProject.mockImplementation((id: string) => Promise.resolve(
      id === 'p1'
        ? { project_id: 'p1', documents: [prfaq, prd] }
        : { project_id: 'p2', documents: [{ ...prfaq, document_id: 'doc_other', title: 'Other proposal' }] },
    ))
    const otherRow = {
      ...row, row_id: 'row_p2_default', project_id: 'p2', document_ids: ['doc_other'],
    }
    prioritizationMocks.getPrioritizationScores.mockResolvedValue({
      scores: {}, rows: { [row.row_id]: row, [otherRow.row_id]: otherRow },
    })
    prioritizationMocks.getFeedbackForms.mockResolvedValue({
      forms: [
        { form_id: 'form_1', name: 'PR/FAQ form', project_id: 'p1', document_id: 'doc_prfaq' },
        { form_id: 'form_2', name: 'PRD form', project_id: 'p1', document_id: 'doc_prd' },
        { form_id: 'form_3', name: 'Other form', project_id: 'p2', document_id: 'doc_other' },
      ],
    })

    await openRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(prioritizationMocks.getFeedbackFormStats).toHaveBeenCalledWith('form_1')
    })
    expect(prioritizationMocks.getFeedbackFormStats).toHaveBeenCalledWith('form_2')
    expect(prioritizationMocks.getFeedbackFormStats).not.toHaveBeenCalledWith('form_3')
  })

  it('makes no stats request at all until a row is expanded', async () => {
    givenOneFormLinkedToThePrfaq('form_1', 'PR/FAQ form')

    await renderUntilRow('Feature A PR/FAQ')
    expect(prioritizationMocks.getFeedbackFormStats).not.toHaveBeenCalled()
  })

  it('keeps the QR out of the row until it is asked for', async () => {
    await openRowShowingTheConceptTest()

    // A QR needs ~200px to scan, and a pitch discusses one artifact at a time —
    // the row's resting state stays the count and the average it shipped with.
    expectShippedCountAndAverage()
    expect(screen.queryByRole('img', { name: qrName('PR/FAQ concept test') })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens a scannable QR for the linked form, and closes it again', async () => {
    const user = await openRowShowingTheConceptTest()
    // A button, so it is reachable and operable from the keyboard.
    await user.click(screen.getByRole('button', { name: t('components:formQrCode.show') }))

    const dialog = screen.getByRole('dialog')
    // Named, not an anonymous overlay — and the QR inside it names its form.
    expect(dialog).toHaveAccessibleName(t('components:formQrCode.title'))
    expect(screen.getByRole('img', { name: qrName('PR/FAQ concept test') })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('spends no extra request on the QR beyond what the row already fetched', async () => {
    givenOneFormLinkedToThePrfaq('form_1', 'PR/FAQ concept test')
    const user = userEvent.setup()

    await openRow('Feature A PR/FAQ')
    await waitFor(() => {
      expect(prioritizationMocks.getFeedbackFormStats).toHaveBeenCalledTimes(1)
    })
    const formsListCalls = prioritizationMocks.getFeedbackForms.mock.calls.length

    await user.click(screen.getByRole('button', { name: t('components:formQrCode.show') }))

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
    // The row already holds the form object; the QR is derived from its id. A
    // fetch here would be paid on a page that is already N+1 on project reads.
    expect(prioritizationMocks.getFeedbackFormStats).toHaveBeenCalledTimes(1)
    expect(prioritizationMocks.getFeedbackForms.mock.calls.length).toBe(formsListCalls)
  })

  it('says why there is no QR when the endpoint cannot address the form', async () => {
    // A scheme-less paste: non-empty, so the page's queries run and the row is
    // fully populated, but nothing built from it opens on a phone.
    mutableConfig.apiEndpoint = 'api.example.com'
    const user = await openRowShowingTheConceptTest()
    await user.click(screen.getByRole('button', { name: t('components:formQrCode.show') }))

    // The dialog opens and explains itself rather than presenting a symbol that
    // scans perfectly and opens nothing.
    expect(screen.getByText(t('components:formQrCode.unavailable'))).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: qrName('PR/FAQ concept test') })).not.toBeInTheDocument()
  })

  it('withholds the QR when the linked form no longer exists', async () => {
    givenTheLinkedFormIsGone()

    await openRow('Feature A PR/FAQ')

    await expectEvidenceUnavailable()
    // Its public page is gone too, so a QR would send the room to a 404.
    expect(screen.queryByRole('button', { name: t('components:formQrCode.show') })).not.toBeInTheDocument()
  })

  it('renders the row when the forms list request fails', async () => {
    // Evidence is a nice-to-have; scoring must not become impossible without it.
    prioritizationMocks.getFeedbackForms.mockRejectedValue(new Error('boom'))

    await openRow('Feature A PR/FAQ')

    await expectScoresPanelShown()
    // Once per document of the row, as when the list arrives holding nothing.
    expect(screen.getAllByText(t('prioritization:evidence.noLinkedForm'))).toHaveLength(2)
  })
})
