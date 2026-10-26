/**
 * Tests for the validation link in the form editor.
 *
 * The load-bearing behaviours: a stored link survives an edit round-trip through
 * the editor (rather than being silently cleared on Save), the link can be
 * cleared on purpose, and a form that validates nothing keeps saving exactly the
 * payload it did before these fields existed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { SCORABLE_TYPE_META } from '../Prioritization/prioritizationUtils'
import {
  feedbackFormsApiMocks, clientApiModule, configStoreModule, createFormsWrapper,
} from './feedback-forms-fixtures'

const {
  getFeedbackForms: mockGetFeedbackForms,
  updateFeedbackForm: mockUpdateFeedbackForm,
  createFeedbackForm: mockCreateFeedbackForm,
} = feedbackFormsApiMocks
const mockGetProjects = vi.fn<(...args: unknown[]) => unknown>()
const mockGetProject = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/client', () => clientApiModule())

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProjects: () => mockGetProjects(),
    getProject: (id: string) => mockGetProject(id),
  },
}))

vi.mock('../../store/configStore', () => configStoreModule())

vi.mock('./TemplateWizard', () => ({
  default: () => <div data-testid="template-wizard" />,
}))

vi.mock('./FormCard', () => ({
  default: ({ form, onEdit }: {
    form: { form_id: string; name: string }
    onEdit: (f: unknown) => void
  }) => (
    <div data-testid={`form-card-${form.form_id}`}>
      <button onClick={() => onEdit(form)}>Edit {form.name}</button>
    </div>
  ),
}))

import FeedbackForms from './FeedbackForms'
import { at } from '@test/defined'

const { t } = i18n

const linkedForm = {
  form_id: 'form_1',
  name: 'PR/FAQ concept test',
  enabled: true,
  project_id: 'p1',
  document_id: 'doc_prfaq',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const unlinkedForm = {
  form_id: 'form_9',
  name: 'Website Footer Form',
  enabled: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

/** Open the editor for one form and switch to the validation tab. */
async function openValidationTab(formName: string) {
  const user = userEvent.setup()
  render(<FeedbackForms />, { wrapper: createFormsWrapper() })

  await waitFor(() => {
    expect(screen.getByText(`Edit ${formName}`)).toBeInTheDocument()
  })
  await user.click(screen.getByText(`Edit ${formName}`))
  await user.click(at(screen.getAllByText(t('feedbackForms:editor.tabs.validates')), 0))
  return user
}

/** Serve a single linked form with `overrides` applied, then open its validation tab. */
function openLinkedFormVariant(overrides: Partial<typeof linkedForm>) {
  mockGetFeedbackForms.mockResolvedValue({
    forms: [{ ...linkedForm, ...overrides }],
  })
  return openValidationTab('PR/FAQ concept test')
}

const projectSelect = () => screen.getByLabelText(t('feedbackForms:editor.validationProjectLabel'))
const documentSelect = () => screen.getByLabelText(t('feedbackForms:editor.validationDocumentLabel'))

type User = ReturnType<typeof userEvent.setup>

async function expectProjectValue(value: string) {
  await waitFor(() => {
    expect(projectSelect()).toHaveValue(value)
  })
}

async function expectDocumentValue(value: string) {
  await waitFor(() => {
    expect(documentSelect()).toHaveValue(value)
  })
}

/** Press Save and assert the PUT body carried exactly these link fields. */
async function expectSavedLink(user: User, link: Record<string, string>) {
  await user.click(screen.getByText('Save Changes'))

  await waitFor(() => {
    expect(mockUpdateFeedbackForm).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining(link))
  })
}

/**
 * The full option text for the `doc_prfaq` fixture: title, then its type.
 *
 * Spelled out as a literal rather than composed from `documentOptionLabel` — a
 * test that builds the expected string the way the component does passes for any
 * format, including one that drops the type entirely.
 */
const PRFAQ_OPTION_LABEL = 'Feature A PR/FAQ (PR/FAQ)'

describe('validation link in the form editor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedbackForms.mockResolvedValue({ forms: [linkedForm, unlinkedForm] })
    mockUpdateFeedbackForm.mockResolvedValue({ success: true })
    mockCreateFeedbackForm.mockResolvedValue({ success: true })
    // These two were fixed responses in this spec's own api mock before the
    // mock surface moved to the shared fixtures; keep them resolving the same.
    feedbackFormsApiMocks.deleteFeedbackForm.mockResolvedValue({ success: true })
    feedbackFormsApiMocks.getCategoriesConfig.mockResolvedValue({ categories: [] })
    mockGetProjects.mockResolvedValue({
      projects: [
        { project_id: 'p1', name: 'Project One', status: 'active', created_at: '', updated_at: '', persona_count: 0, document_count: 1 },
        { project_id: 'p2', name: 'Project Two', status: 'active', created_at: '', updated_at: '', persona_count: 0, document_count: 0 },
      ],
    })
    mockGetProject.mockResolvedValue({
      project_id: 'p1',
      documents: [
        { document_id: 'doc_prfaq', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '' },
        { document_id: 'doc_research', document_type: 'research', title: 'Research Notes', content: '', created_at: '' },
      ],
    })
  })

  it('shows the stored link when the editor opens', async () => {
    await openValidationTab('PR/FAQ concept test')

    await expectProjectValue('p1')
    expect(documentSelect()).toHaveValue('doc_prfaq')
  })

  it('round-trips a stored link through Save untouched', async () => {
    // The regression this guards: opening the editor and saving without
    // touching the link must not clear it.
    const user = await openValidationTab('PR/FAQ concept test')

    await expectProjectValue('p1')
    await expectSavedLink(user, { project_id: 'p1', document_id: 'doc_prfaq' })
  })

  it('lets an admin clear the link, and clears the document with the project', async () => {
    const user = await openValidationTab('PR/FAQ concept test')

    await expectProjectValue('p1')
    await user.selectOptions(projectSelect(), '')
    // Empty strings, not undefined: the backend PUT only writes fields present
    // in the body, so an omitted field would leave the old link in place.
    await expectSavedLink(user, { project_id: '', document_id: '' })
  })

  it('lets an admin link an unlinked form to a project and document', async () => {
    const user = await openValidationTab('Website Footer Form')

    await expectProjectValue('')
    await user.selectOptions(projectSelect(), 'p1')
    await waitFor(() => {
      expect(screen.getByText(PRFAQ_OPTION_LABEL)).toBeInTheDocument()
    })
    await user.selectOptions(documentSelect(), 'doc_prfaq')
    await expectSavedLink(user, { project_id: 'p1', document_id: 'doc_prfaq' })
  })

  it('saves a form that validates nothing as unlinked', async () => {
    const user = await openValidationTab('Website Footer Form')

    await expectProjectValue('')
    await expectSavedLink(user, { project_id: '', document_id: '' })
  })

  it('offers only scorable document types — a form on research notes shows on no row', async () => {
    await openValidationTab('PR/FAQ concept test')

    await waitFor(() => {
      expect(screen.getByText(PRFAQ_OPTION_LABEL)).toBeInTheDocument()
    })
    // Substring, not the full option text: what must not be offered is that
    // document, under any label this picker might give it. queryAll, because
    // queryBy throws on multiple matches — the failure would then read "found
    // multiple elements" instead of naming the leak.
    expect(screen.queryAllByText(/Research Notes/)).toHaveLength(0)
  })

  it('keeps a link whose document no longer exists rather than silently clearing it', async () => {
    const user = await openLinkedFormVariant({ document_id: 'doc_v1' })

    await expectDocumentValue('doc_v1')
    expect(screen.getByText(t('feedbackForms:editor.validationUnknownDocument'))).toBeInTheDocument()

    await expectSavedLink(user, { document_id: 'doc_v1' })
  })

  it('disables the document select until a project is chosen', async () => {
    await openValidationTab('Website Footer Form')

    await waitFor(() => {
      expect(documentSelect()).toBeDisabled()
    })
  })

  it('does not call an intact link unavailable while the project detail is still loading', async () => {
    // The document list is empty on the first render of EVERY linked form, so
    // deciding "missing" from an empty list alarms the admin about a link that
    // is perfectly fine. The stored id must still be the select's value — Save
    // has to round-trip it either way — but under a neutral label.
    const detail = { resolve: (_detail: unknown) => {} }
    mockGetProject.mockImplementation(() => new Promise((resolve) => {
      detail.resolve = resolve
    }))

    await openValidationTab('PR/FAQ concept test')

    await expectDocumentValue('doc_prfaq')
    expect(
      screen.queryByText(t('feedbackForms:editor.validationUnknownDocument')),
    ).not.toBeInTheDocument()
    expect(screen.getByText(t('feedbackForms:editor.validationLoadingLink'))).toBeInTheDocument()

    detail.resolve({
      project_id: 'p1',
      documents: [
        { document_id: 'doc_prfaq', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '' },
      ],
    })

    // Once it lands, the real title replaces the placeholder and no "missing"
    // label ever appeared.
    await waitFor(() => {
      expect(screen.getByText(PRFAQ_OPTION_LABEL)).toBeInTheDocument()
    })
    const transientLabels = [
      t('feedbackForms:editor.validationLoadingLink'),
      t('feedbackForms:editor.validationUnknownDocument'),
    ]
    expect(transientLabels.filter((label) => screen.queryByText(label) !== null)).toStrictEqual([])
  })

  it('keeps a link whose project no longer exists rather than showing it as unlinked', async () => {
    // Symmetric to the stale document: the id is still in formData, so showing
    // "-- Not linked --" tells the admin the form is unlinked while Save
    // persists the link anyway.
    const user = await openLinkedFormVariant({ project_id: 'p_deleted' })

    await expectProjectValue('p_deleted')
    expect(screen.getByText(t('feedbackForms:editor.validationUnknownProject'))).toBeInTheDocument()

    await expectSavedLink(user, { project_id: 'p_deleted' })
  })

  it('does not call an intact project link unavailable while the project list loads', async () => {
    const projects = { resolve: (_projects: unknown) => {} }
    mockGetProjects.mockImplementation(() => new Promise((resolve) => {
      projects.resolve = resolve
    }))

    await openValidationTab('PR/FAQ concept test')

    await expectProjectValue('p1')
    expect(
      screen.queryByText(t('feedbackForms:editor.validationUnknownProject')),
    ).not.toBeInTheDocument()

    projects.resolve({
      projects: [
        { project_id: 'p1', name: 'Project One', status: 'active', created_at: '', updated_at: '', persona_count: 0, document_count: 1 },
      ],
    })

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument()
    })
    expect(
      screen.queryByText(t('feedbackForms:editor.validationUnknownProject')),
    ).not.toBeInTheDocument()
  })

  it('reuses the shared project query keys so the cache is not split', async () => {
    // A literal key here would still work — it would just address a separate
    // cache entry and miss Projects.tsx's invalidations. Nothing observable
    // fails, hence this test.
    const source = readFileSync(
      join(__dirname, 'ValidationLinkPicker.tsx'), 'utf-8',
    )

    expect(source).toContain("from '../../api/projectQueryKeys'")
    expect(source).toContain('queryKey: projectKey(')
    expect(source).toContain('queryKey: projectsKey()')
    expect(source, 'query keys must come from the shared helper, not literals')
      .not.toMatch(/queryKey: \['project/)
  })

  it('offers every document type the Prioritization page scores', async () => {
    // Lockstep, not a restatement of the test above: SCORABLE_TYPE_META
    // documents itself as the single source of truth for which types are
    // scorable, and a form can only show its ratings on a row that exists. A
    // third type added there must become linkable here with no second edit —
    // this fails if the picker ever hardcodes its own narrower list again.
    const scorableTypes = Object.keys(SCORABLE_TYPE_META)
    expect(scorableTypes.length, 'nothing is scorable — fixture is broken')
      .toBeGreaterThan(0)

    mockGetProject.mockResolvedValue({
      project_id: 'p1',
      documents: scorableTypes.map((type) => ({
        document_id: `doc_${type}`,
        document_type: type,
        title: `Doc ${type}`,
        content: '',
        created_at: '',
      })),
    })

    await openValidationTab('PR/FAQ concept test')

    await waitFor(() => {
      expect(documentSelect().querySelectorAll('option').length).toBeGreaterThan(1)
    })
    // Matched on the option's VALUE, not its text: the text now carries a
    // per-type label this test deliberately knows nothing about — it asserts
    // only that every scorable type is offered.
    const optionValues = [...documentSelect().querySelectorAll('option')].map((o) => o.value)
    for (const type of scorableTypes) {
      expect(
        optionValues,
        `${type} is scorable on Prioritization but the picker will not link to it`,
      ).toContain(`doc_${type}`)
    }
  })

  it('labels every option with the document type, not the title alone', async () => {
    // The reason this matters: a project's PRD and PR/FAQ come from the same
    // feature idea and routinely carry the SAME title, so a list of names cannot
    // be used to pick between them — and they are separate rows on the
    // Prioritization page, where this form's ratings then appear.
    mockGetProject.mockResolvedValue({
      project_id: 'p1',
      documents: [
        { document_id: 'doc_prd', document_type: 'prd', title: 'Instant payouts', content: '', created_at: '' },
        { document_id: 'doc_prfaq', document_type: 'prfaq', title: 'Instant payouts', content: '', created_at: '' },
      ],
    })

    await openValidationTab('PR/FAQ concept test')

    // Full option text, spelled out: the two same-titled documents are now
    // distinguishable, and each says which one it is.
    await waitFor(() => {
      expect(screen.getByText('Instant payouts (PRD)')).toBeInTheDocument()
    })
    expect(screen.getByText('Instant payouts (PR/FAQ)')).toBeInTheDocument()
    // And the bare title is no longer any option's text — if it were, the two
    // would still be indistinguishable.
    expect(screen.queryByText('Instant payouts')).not.toBeInTheDocument()
  })

  it('falls back to the document id when a record has no title', async () => {
    // `ProjectDocument.title` is declared `string` but projectsApi has no schema
    // at its boundary, so a legacy record without one reaches this render. Before
    // the type label, `{doc.title}` rendered an empty option for it; interpolating
    // it into a template would print the literal "undefined" to the admin.
    mockGetProject.mockResolvedValue({
      project_id: 'p1',
      documents: [
        { document_id: 'doc_untitled', document_type: 'prd', content: '', created_at: '' },
        { document_id: 'doc_blank', document_type: 'prfaq', title: '   ', content: '', created_at: '' },
      ],
    })

    await openValidationTab('PR/FAQ concept test')

    await waitFor(() => {
      expect(screen.getByText('doc_untitled (PRD)')).toBeInTheDocument()
    })
    expect(screen.getByText('doc_blank (PR/FAQ)')).toBeInTheDocument()
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
  })

  it('does not claim to be loading when the project list request fails', async () => {
    // A rejected query is not "loading" and it is not "no longer available"
    // either — nobody managed to look. Saying either is a false statement next
    // to a link the admin is about to Save.
    mockGetProjects.mockRejectedValue(new Error('projects unavailable'))

    const user = await openValidationTab('PR/FAQ concept test')

    await waitFor(() => {
      expect(
        screen.getByText(t('feedbackForms:editor.validationUnverifiedProject')),
      ).toBeInTheDocument()
    })
    expect(projectSelect()).toHaveValue('p1')
    expect(
      screen.queryByText(t('feedbackForms:editor.validationLoadingLink')),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(t('feedbackForms:editor.validationUnknownProject')),
    ).not.toBeInTheDocument()

    // And the link still round-trips: a failed lookup must not clear it.
    await expectSavedLink(user, { project_id: 'p1', document_id: 'doc_prfaq' })
  })

  it('does not claim to be loading a document list it will never request', async () => {
    // A document_id with no project_id is reachable — the API validates the two
    // link fields independently, so `PUT {"document_id": "..."}` alone persists
    // this shape. It disables the detail query, so the list can never resolve and
    // "Loading link…" would sit there forever: the same defect one level down
    // from the one this control was fixed for.
    await openLinkedFormVariant({ project_id: '', document_id: 'doc_orphan' })

    await waitFor(() => {
      expect(
        screen.getByText(t('feedbackForms:editor.validationUnverifiedDocument')),
      ).toBeInTheDocument()
    })
    expect(documentSelect()).toBeDisabled()
    expect(documentSelect()).toHaveValue('doc_orphan')
    // No detail request without a project, so nothing to wait on either.
    expect({
      detailRequests: mockGetProject.mock.calls.length,
      showsLoading: screen.queryByText(t('feedbackForms:editor.validationLoadingLink')) !== null,
    }).toStrictEqual({ detailRequests: 0, showsLoading: false })
  })

  it('does not claim to be loading when the project detail request fails', async () => {
    mockGetProject.mockRejectedValue(new Error('detail unavailable'))

    await openValidationTab('PR/FAQ concept test')

    await waitFor(() => {
      expect(
        screen.getByText(t('feedbackForms:editor.validationUnverifiedDocument')),
      ).toBeInTheDocument()
    })
    expect(documentSelect()).toHaveValue('doc_prfaq')
    expect(
      screen.queryByText(t('feedbackForms:editor.validationUnknownDocument')),
    ).not.toBeInTheDocument()
  })
})
