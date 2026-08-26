/**
 * A reviewer changes which rows exist: adds one, edits an un-balloted one's
 * documents, and — as an admin — deletes one with its ballots.
 *
 * What these assert is the REQUEST and what the page then SAYS, because those are the
 * two things the routes and the reader respectively depend on. Every rule the panel
 * appears to enforce is the server's — the freeze is a condition on the write, the
 * bound on documents and rows is checked there, the delete is admin-gated — so a
 * hidden control is only a courtesy, and the case that matters most is the page
 * stating a refusal it could not prevent (the 409).
 *
 * Its own file rather than more of `Prioritization.test.tsx`, which is already the
 * largest in the suite, and it needs its own `useIsAdmin` mock: the delete control is
 * offered on that answer, so both sides of it have to be drivable per test.
 */
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest'
import {
  render, screen, waitFor, within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

const mockGetProjects = vi.fn()
const mockGetProject = vi.fn()
const mockGetPrioritizationScores = vi.fn()
const mockCreatePrioritizationRow = vi.fn()
const mockCompose = vi.fn()
const mockRecompose = vi.fn()
const mockDelete = vi.fn()
const mockIsAdmin = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProjects: () => mockGetProjects(),
    getProject: (id: string) => mockGetProject(id),
  },
}))

vi.mock('../../api/client', () => ({
  api: {
    getPrioritizationScores: () => mockGetPrioritizationScores(),
    createPrioritizationRow: (id: string) => mockCreatePrioritizationRow(id),
    patchPrioritizationScores: () => Promise.resolve({ success: true }),
    getFeedbackForms: () => Promise.resolve({ forms: [] }),
    getFeedbackFormStats: () => Promise.resolve({ success: true, stats: null }),
  },
}))

vi.mock('../../api/prioritizationRowsApi', () => ({
  prioritizationRowsApi: {
    composePrioritizationRow: (input: unknown) => mockCompose(input),
    recomposePrioritizationRow: (rowId: string, input: unknown) => mockRecompose(rowId, input),
    deletePrioritizationRow: (rowId: string) => mockDelete(rowId),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com' } }),
}))

vi.mock('../../store/authStore', () => ({
  useIsAdmin: () => mockIsAdmin(),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))

import Prioritization from './Prioritization'

const ROW_ID = 'row_p1_default'
const PRFAQ_TITLE = 'Feature A PR/FAQ'
const PRD_TITLE = 'Feature A PRD'

const project = {
  project_id: 'p1',
  name: 'Project 1',
  status: 'active',
  created_at: '2025-01-01',
  updated_at: '2025-01-01',
  persona_count: 0,
  document_count: 2,
}

/** The project's two scorable documents, plus a prototype no row may be composed from. */
const documents = [
  {
    document_id: 'doc_prfaq', document_type: 'prfaq', title: PRFAQ_TITLE,
    content: '# Feature A', created_at: '2025-02-01',
  },
  {
    document_id: 'doc_prd', document_type: 'prd', title: PRD_TITLE,
    content: 'PRD content', created_at: '2025-01-01',
  },
  {
    document_id: 'doc_proto', document_type: 'prototype', title: 'Feature A prototype',
    content: '', created_at: '2025-03-01',
  },
]

/** The stored row, holding BOTH scorable documents unless a case says otherwise. */
const storedRow = (overrides: Record<string, unknown> = {}) => ({
  row_id: ROW_ID,
  project_id: 'p1',
  document_ids: ['doc_prfaq', 'doc_prd'],
  prototype_id: 'doc_proto',
  is_default: true,
  created_at: '2025-01-01',
  is_frozen: false,
  ...overrides,
})

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/', element: <Prioritization /> }])
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return queryClient
}

/**
 * Render, wait for the row, and open it — every composition control lives inside the
 * expansion, like the sliders and the room vote.
 */
async function openTheRow() {
  const user = userEvent.setup()
  renderPage()
  await waitFor(() => {
    expect(screen.getByText(PRFAQ_TITLE)).toBeInTheDocument()
  })
  await user.click(screen.getByRole('button', { name: new RegExp(PRFAQ_TITLE) }))
  const panel = await screen.findByTestId(`row-composition-${ROW_ID}`)
  return { user, panel }
}

/** The one document-picker on screen, whichever control opened it. */
function picker(): HTMLElement {
  return screen.getByRole('group', { name: /Documents this row holds/ })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsAdmin.mockReturnValue(false)
  mockGetProjects.mockResolvedValue({ projects: [project] })
  mockGetProject.mockResolvedValue({ project_id: 'p1', documents })
  mockGetPrioritizationScores.mockResolvedValue({
    rows: { [ROW_ID]: storedRow() },
    scores: {},
    aggregates: {},
  })
  mockCreatePrioritizationRow.mockResolvedValue({
    success: true, created: false, row: storedRow(),
  })
  mockCompose.mockResolvedValue({ success: true, created: true })
  mockRecompose.mockResolvedValue({ success: true })
  mockDelete.mockResolvedValue({ ballots_deleted: 3 })
})

describe('adding another row for a chosen project', () => {
  it('composes a row from the documents the reviewer ticked', async () => {
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Add row/ }))
    // Start from the row's own composition and NARROW it: unticking the PR/FAQ leaves
    // a new row holding the PRD alone, which is exactly "score a different
    // combination". The body has to carry the project too — the route validates the
    // ids against that project's own documents.
    await user.click(within(picker()).getByRole('checkbox', { name: new RegExp(PRFAQ_TITLE) }))
    await user.click(screen.getByRole('button', { name: /Add the row/ }))

    await waitFor(() => {
      expect(mockCompose).toHaveBeenCalledWith({
        project_id: 'p1', document_ids: ['doc_prd'],
      })
    })
  })

  it('refreshes the authoritative row read once the compose lands', async () => {
    // The page renders the read, never an optimistic row: only the read knows what the
    // compose actually stored, and the row it answers is a courtesy nothing displays.
    const { user } = await openTheRow()
    const readsBefore = mockGetPrioritizationScores.mock.calls.length

    await user.click(screen.getByRole('button', { name: /Add row/ }))
    await user.click(screen.getByRole('button', { name: /Add the row/ }))

    await waitFor(() => {
      expect(mockGetPrioritizationScores.mock.calls.length).toBeGreaterThan(readsBefore)
    })
  })

  it('offers only PRDs and PR/FAQs, never the project prototype', async () => {
    // The candidate set the route accepts. A prototype in `document_ids` is refused
    // ("not a PRD or a PR/FAQ"), so offering one would invite a 404 a reviewer cannot
    // act on — while the row still shows that prototype as context.
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Add row/ }))

    const boxes = within(picker()).getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    expect(within(picker()).queryByRole('checkbox', { name: /prototype/i })).toBeNull()
  })

  it('will not submit a row with nothing to score', async () => {
    // A row with nothing to score is not a row, and the API refuses an empty set in
    // the same words. Blocked before the request rather than after, with the reason
    // beside the disabled control.
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Add row/ }))
    for (const box of within(picker()).getAllByRole('checkbox')) await user.click(box)

    expect(screen.getByRole('button', { name: /Add the row/ })).toBeDisabled()
    expect(screen.getByText(/at least one document/i)).toBeInTheDocument()
    expect(mockCompose).not.toHaveBeenCalled()
  })
})

describe('changing an un-balloted row composition', () => {
  it('preselects the documents the row holds', async () => {
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Edit documents/ }))

    for (const title of [PRFAQ_TITLE, PRD_TITLE]) {
      expect(within(picker()).getByRole('checkbox', { name: new RegExp(title) })).toBeChecked()
    }
  })

  it('patches the row with the narrowed set, and refreshes the read', async () => {
    const { user } = await openTheRow()
    const readsBefore = mockGetPrioritizationScores.mock.calls.length

    await user.click(screen.getByRole('button', { name: /Edit documents/ }))
    await user.click(within(picker()).getByRole('checkbox', { name: new RegExp(PRD_TITLE) }))
    await user.click(screen.getByRole('button', { name: /Save documents/ }))

    await waitFor(() => {
      expect(mockRecompose).toHaveBeenCalledWith(ROW_ID, {
        project_id: 'p1', document_ids: ['doc_prfaq'],
      })
    })
    // The visible composition comes from the refreshed read, not from what was
    // submitted — the write's own answer is not what this page renders.
    await waitFor(() => {
      expect(mockGetPrioritizationScores.mock.calls.length).toBeGreaterThan(readsBefore)
    })
  })

  it('shows the composition the refreshed read reports, not the one submitted', async () => {
    // The other half of "success updates the visible composition": the row's badges
    // and its expansion are built from the read, so a landed save shows through it.
    mockGetPrioritizationScores
      .mockResolvedValueOnce({ rows: { [ROW_ID]: storedRow() }, scores: {}, aggregates: {} })
      .mockResolvedValue({
        rows: { [ROW_ID]: storedRow({ document_ids: ['doc_prfaq'] }) },
        scores: {},
        aggregates: {},
      })
    const { user } = await openTheRow()
    expect(screen.getAllByText(PRD_TITLE).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: /Edit documents/ }))
    await user.click(within(picker()).getByRole('checkbox', { name: new RegExp(PRD_TITLE) }))
    await user.click(screen.getByRole('button', { name: /Save documents/ }))

    // The PRD is gone from the row entirely — its badge, its preview and the picker's
    // preselection all read the same refreshed record.
    await waitFor(() => {
      expect(screen.queryByText(PRD_TITLE)).toBeNull()
    })
    expect(screen.getAllByText(PRFAQ_TITLE).length).toBeGreaterThan(0)
  })
})

describe('a frozen row', () => {
  beforeEach(() => {
    mockGetPrioritizationScores.mockResolvedValue({
      rows: { [ROW_ID]: storedRow({ is_frozen: true }) },
      scores: {},
      aggregates: {},
    })
    mockCreatePrioritizationRow.mockResolvedValue({
      success: true, created: false, row: storedRow({ is_frozen: true }),
    })
  })

  it('stays scoreable, with its sliders and its note', async () => {
    // The whole point of freezing rather than closing a row: the first ballot settles
    // what the row IS, and everyone else still scores it.
    await openTheRow()

    expect(await screen.findAllByRole('slider')).toHaveLength(4)
    expect(screen.getByPlaceholderText(/notes about this prioritization/i)).toBeEnabled()
  })

  it('withdraws composition editing and says the first ballot locked it', async () => {
    await openTheRow()

    expect(screen.queryByRole('button', { name: /Edit documents/ })).toBeNull()
    expect(screen.getByText(/Locked since the first ballot/)).toBeInTheDocument()
  })

  it('offers adding another row as the action instead', async () => {
    // The reviewer's goal — score a different combination — is still reachable, just
    // not by editing this row. A frozen row with no action at all would be a dead end.
    const { user } = await openTheRow()

    const addRow = screen.getByRole('button', { name: /Add row/ })
    await user.click(addRow)

    expect(picker()).toBeInTheDocument()
  })
})

describe('deleting a row with its ballots', () => {
  it('shows no delete control to a reviewer who is not an admin', async () => {
    // The refusal is the server's — `require_admin` answers 403 before anything is
    // read — so this is the courtesy half: nobody is invited to press a button that
    // cannot work.
    mockIsAdmin.mockReturnValue(false)

    await openTheRow()

    expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull()
  })

  it('asks an admin to confirm, naming the ballots that go with the row', async () => {
    mockIsAdmin.mockReturnValue(true)
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/every ballot cast on it/i)).toBeInTheDocument()
    // Nothing is deleted by opening the question.
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('deletes nothing when the admin declines', async () => {
    mockIsAdmin.mockReturnValue(true)
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Keep the row/ }))

    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('deletes the row on confirmation and lets the read remove it from the list', async () => {
    // No remount and no optimistic removal: the same query the rest of the page reads
    // simply stops naming that row. `ensuredRows` is reconciled against it, which is
    // what lets the row actually disappear.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores
      .mockResolvedValueOnce({ rows: { [ROW_ID]: storedRow() }, scores: {}, aggregates: {} })
      .mockResolvedValue({ rows: {}, scores: {}, aggregates: {} })
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(ROW_ID)
    })
    await waitFor(() => {
      expect(screen.queryByText(PRFAQ_TITLE)).toBeNull()
    })
  })
})

describe('the page reports a row write that did not land', () => {
  it('states the freeze when a ballot landed before the recompose', async () => {
    // THE REFUSAL A HIDDEN CONTROL CANNOT PREVENT. The freeze is a condition on the
    // write, so a first ballot landing while this editor is open wins — the row read
    // as editable a moment earlier and the request is refused anyway. Reported as the
    // state conflict it is, with the action that IS available named.
    mockRecompose.mockRejectedValue(new Error('API Error: 409'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Edit documents/ }))
    await user.click(screen.getByRole('button', { name: /Save documents/ }))

    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })
    expect(within(alert).getByText(/a ballot has already been cast/i)).toBeInTheDocument()
    expect(within(alert).getByText(new RegExp(PRFAQ_TITLE))).toBeInTheDocument()
  })

  it('states a compose refused at the project row bound', async () => {
    mockCompose.mockRejectedValue(new Error('API Error: 409'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Add row/ }))
    await user.click(screen.getByRole('button', { name: /Add the row/ }))

    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })
    expect(within(alert).getByText(/as many rows as it may/i)).toBeInTheDocument()
  })

  it('distinguishes a passing failure from a conflict, and does not send a reader to reload', async () => {
    // A 500 did not land and can simply be tried again; telling a reader to reload
    // sends them to re-read state that never changed. Same panel, different sentence.
    mockCompose.mockRejectedValue(new Error('API Error: 500'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Add row/ }))
    await user.click(screen.getByRole('button', { name: /Add the row/ }))

    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })
    expect(within(alert).getByText(/you can try again/i)).toBeInTheDocument()
    expect(within(alert).queryByText(/Reload the page/)).toBeNull()
  })

  it('states a delete that was refused, and keeps the row on screen', async () => {
    mockIsAdmin.mockReturnValue(true)
    mockDelete.mockRejectedValue(new Error('API Error: 409'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))

    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })
    expect(within(alert).getByText(/was not deleted/i)).toBeInTheDocument()
    // The row is untouched, and the list still shows it — a failed delete that emptied
    // the row off the page would be worse than the refusal.
    expect(screen.getAllByText(PRFAQ_TITLE).length).toBeGreaterThan(0)
  })

  it('lets a reader dismiss the failure', async () => {
    mockCompose.mockRejectedValue(new Error('API Error: 500'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Add row/ }))
    await user.click(screen.getByRole('button', { name: /Add the row/ }))
    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })

    await user.click(within(alert).getByRole('button', { name: /Dismiss this message/ }))

    expect(screen.queryByRole('alert', { name: /That change to the rows was not saved/ })).toBeNull()
  })
})

describe('a project the default-row route permanently refuses', () => {
  it('names the project rather than dropping it silently', async () => {
    // The 409 for a project holding more documents than a row can be composed from in
    // one read. Permanent by construction and covered by nothing until now: the
    // project simply did not appear in the backlog, with nothing saying why.
    mockCreatePrioritizationRow.mockRejectedValue(new Error('API Error: 409'))
    mockGetPrioritizationScores.mockResolvedValue({ rows: {}, scores: {}, aggregates: {} })

    renderPage()

    const alert = await screen.findByRole('alert', { name: /Some projects could not be given a row/ })
    expect(within(alert).getByText('Project 1')).toBeInTheDocument()
  })

  it('stays silent for a project with no scorable document, which the list already invites', async () => {
    // The other permanent refusal, deliberately not a panel: "no PRD or PR/FAQ to
    // score" is what the list's own empty state says, in words a reader can act on. A
    // red panel over the ordinary state of a fresh project would be noise.
    mockGetProject.mockResolvedValue({
      project_id: 'p1',
      documents: [documents[2]],
    })
    mockCreatePrioritizationRow.mockRejectedValue(new Error('API Error: 400'))
    mockGetPrioritizationScores.mockResolvedValue({ rows: {}, scores: {}, aggregates: {} })

    renderPage()

    await waitFor(() => {
      expect(screen.getByText(/No Scorable Documents/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('alert', { name: /Some projects could not be given a row/ })).toBeNull()
  })
})

describe('a successful read settles which rows exist', () => {
  it('drops a row the asks confirmed once a read no longer names it', async () => {
    // `ensuredRows` was sticky for the mount, so the merge could only ADD — and a
    // deleted row stayed on screen until a remount. A read that PUBLISHED rows is the
    // authority on what exists.
    mockGetPrioritizationScores
      .mockResolvedValueOnce({ rows: { [ROW_ID]: storedRow() }, scores: {}, aggregates: {} })
      .mockResolvedValue({ rows: {}, scores: {}, aggregates: {} })
    const queryClient = renderPage()
    await waitFor(() => {
      expect(screen.getByText(PRFAQ_TITLE)).toBeInTheDocument()
    })

    await queryClient.invalidateQueries({ queryKey: ['prioritization-scores'] })

    await waitFor(() => {
      expect(screen.queryByText(PRFAQ_TITLE)).toBeNull()
    })
  })

  it('keeps the ask-confirmed rows when the read FAILS, which is what the fallback is for', async () => {
    // The direction the reconciliation must not break: rows are this page's entire
    // content, and read from the one query alone a 500 emptied the page rather than
    // only the numbers on it.
    mockGetPrioritizationScores.mockRejectedValue(new Error('API Error: 500'))

    renderPage()

    await waitFor(() => {
      expect(screen.getByText(PRFAQ_TITLE)).toBeInTheDocument()
    })
  })

  it('keeps them for a deployment that publishes no rows field at all', async () => {
    // An absent `rows` normalises to an empty map, which is indistinguishable from a
    // deployment holding none — so reconciling against it would empty the page on an
    // older API. Only a PUBLISHED map is authoritative.
    mockGetPrioritizationScores.mockResolvedValue({ scores: {}, aggregates: {} })

    renderPage()

    await waitFor(() => {
      expect(screen.getByText(PRFAQ_TITLE)).toBeInTheDocument()
    })
  })
})
