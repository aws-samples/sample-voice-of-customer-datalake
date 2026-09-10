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
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import {
  fireEvent, render, screen, waitFor, within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'

const mockGetProjects = vi.fn()
const mockGetProject = vi.fn()
const mockGetPrioritizationScores = vi.fn()
const mockCreatePrioritizationRow = vi.fn()
const mockCompose = vi.fn()
const mockRecompose = vi.fn()
const mockDelete = vi.fn()
const mockPatchPrioritizationScores = vi.fn()
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
    patchPrioritizationScores: (edits: unknown) => mockPatchPrioritizationScores(edits),
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
/**
 * A SECOND row of the same project, which is what makes the default row deletable.
 *
 * `api_delete_prioritization_row` refuses a default row while it is a project's only
 * row, so the page withholds the control in that shape — see `secondRow` and the
 * "only default row" cases.
 */
const SECOND_ROW_ID = 'row_p1_second'
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

/**
 * A reviewer-composed second row of the same project, holding the PRD alone.
 *
 * Present in the read wherever a delete is under test, because a project's only default
 * row is one the API always refuses to delete and the page therefore offers no control
 * for. `is_default: false` — this is a row somebody composed, not the minted one.
 */
const secondRow = (overrides: Record<string, unknown> = {}) => ({
  row_id: SECOND_ROW_ID,
  project_id: 'p1',
  document_ids: ['doc_prd'],
  prototype_id: 'doc_proto',
  is_default: false,
  created_at: '2025-01-01',
  is_frozen: false,
  ...overrides,
})

/** The read a project with two rows answers — the shape every delete case needs. */
const twoRowRead = () => ({
  rows: { [ROW_ID]: storedRow(), [SECOND_ROW_ID]: secondRow() },
  scores: {},
  aggregates: {},
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

// jsdom implements no `scrollIntoView`, and the row-state panels bring themselves into
// view when they appear — see `useAnnouncePanel`. Stubbed here rather than at module
// scope so it does not outlive this file.
let restoreScrollIntoView = () => { /* replaced per test */ }

afterEach(() => {
  restoreScrollIntoView()
})

beforeEach(() => {
  restoreScrollIntoView = stubElementScrollIntoView()
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
  mockPatchPrioritizationScores.mockResolvedValue({ success: true })
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

  it('keeps the reviewer\'s ticks when a refetch moves the row underneath them', async () => {
    // THE SELECTION IS THE REVIEWER'S. The picker used to be `key`ed on the row's stored
    // document ids, so any read that moved them REMOUNTED it and replaced the ticks with
    // the row's own — a silent loss of unsaved input, and the precise opposite of what
    // the surrounding comment promised. It is reachable with no action by this reviewer:
    // `usePrototypeLinkRefresh` invalidates the project fan-out hourly, the row-ensure
    // invalidates the read whenever an ask reports `created`, and another reviewer's
    // recompose moves the composition itself.
    const queryClient = renderPage()
    const user = userEvent.setup()
    await waitFor(() => {
      expect(screen.getByText(PRFAQ_TITLE)).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: new RegExp(PRFAQ_TITLE) }))
    await screen.findByTestId(`row-composition-${ROW_ID}`)
    await user.click(screen.getByRole('button', { name: /Edit documents/ }))
    // Narrowed to the PR/FAQ alone, and NOT submitted.
    await user.click(within(picker()).getByRole('checkbox', { name: new RegExp(PRD_TITLE) }))
    expect(within(picker()).getByRole('checkbox', { name: new RegExp(PRD_TITLE) })).not.toBeChecked()

    // A read lands holding a DIFFERENT composition — somebody else's recompose.
    mockGetPrioritizationScores.mockResolvedValue({
      rows: { [ROW_ID]: storedRow({ document_ids: ['doc_prd'] }) },
      scores: {},
      aggregates: {},
    })
    await queryClient.invalidateQueries({ queryKey: ['prioritization-scores'] })

    // The reviewer's own choice survives it, and a save sends what they ticked.
    await waitFor(() => {
      expect(within(picker()).getByRole('checkbox', { name: new RegExp(PRFAQ_TITLE) })).toBeChecked()
    })
    expect(within(picker()).getByRole('checkbox', { name: new RegExp(PRD_TITLE) })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: /Save documents/ }))
    await waitFor(() => {
      expect(mockRecompose).toHaveBeenCalledWith(ROW_ID, {
        project_id: 'p1', document_ids: ['doc_prfaq'],
      })
    })
  })

  it('re-seeds from the row when the picker is REOPENED, which is what a landed save needs', async () => {
    // The other half of dropping the stored ids from the `key`: nothing re-seeds an open
    // picker, and reopening it reads the row's current documents through `initialIds`.
    mockGetPrioritizationScores
      .mockResolvedValueOnce({ rows: { [ROW_ID]: storedRow() }, scores: {}, aggregates: {} })
      .mockResolvedValue({
        rows: { [ROW_ID]: storedRow({ document_ids: ['doc_prfaq'] }) },
        scores: {},
        aggregates: {},
      })
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Edit documents/ }))
    await user.click(within(picker()).getByRole('checkbox', { name: new RegExp(PRD_TITLE) }))
    await user.click(screen.getByRole('button', { name: /Save documents/ }))
    await waitFor(() => {
      expect(screen.queryByText(PRD_TITLE)).toBeNull()
    })
    await user.click(screen.getByRole('button', { name: /Edit documents/ }))

    // The candidate list is the PROJECT'S documents, so both boxes are still offered —
    // only the preselection follows the row, which is now the PR/FAQ alone.
    expect(within(picker()).getByRole('checkbox', { name: new RegExp(PRFAQ_TITLE) })).toBeChecked()
    expect(within(picker()).getByRole('checkbox', { name: new RegExp(PRD_TITLE) })).not.toBeChecked()
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
  // Every case here needs the project to hold TWO rows: the API refuses to delete a
  // default row while it is a project's only one, and the page withholds the control
  // for exactly that shape — see the "only default row" cases below.
  beforeEach(() => {
    mockGetPrioritizationScores.mockResolvedValue(twoRowRead())
  })

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
      .mockResolvedValueOnce(twoRowRead())
      .mockResolvedValue({ rows: { [SECOND_ROW_ID]: secondRow() }, scores: {}, aggregates: {} })
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

  it('reports the delete and how many ballots went with the row', async () => {
    // `ballots_deleted` IS the evidence the deletion was complete — the row is gone, so
    // nothing can be re-read to check — and it was parsed at the wire boundary and then
    // discarded. A row that simply vanishes looks like a filter or a failed read, for
    // the one action whose dialog just called it irreversible.
    mockIsAdmin.mockReturnValue(true)
    mockDelete.mockResolvedValue({ ballots_deleted: 3 })
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))

    const receipt = await screen.findByRole('status', { name: /The row was deleted/ })
    expect(within(receipt).getByText(/3 ballot/)).toBeInTheDocument()
    expect(within(receipt).getByText(new RegExp(PRFAQ_TITLE))).toBeInTheDocument()
  })

  it('writes a single ballot in the singular', async () => {
    // The counted sentence is a real i18next plural now, not "{{ballots}} ballot(s)".
    // This catalog already ships `rowCount_one`/`rowCount_other` in all eight locales and
    // `localeParity.test.ts` pins the set, so a missing form fails a test here rather
    // than rendering a raw key path at a reader.
    mockIsAdmin.mockReturnValue(true)
    mockDelete.mockResolvedValue({ ballots_deleted: 1 })
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))

    const receipt = await screen.findByRole('status', { name: /The row was deleted/ })
    expect(within(receipt).getByText(/the one ballot cast on it/)).toBeInTheDocument()
    // Neither the plural form nor the old "ballot(s)" hedge, and never a raw key path.
    expect(within(receipt).queryByText(/ballots cast/)).toBeNull()
    expect(within(receipt).queryByText(/ballot\(s\)/)).toBeNull()
    expect(within(receipt).queryByText(/rowDeleted\./)).toBeNull()
  })

  it('writes several ballots in the plural, with the count', async () => {
    mockIsAdmin.mockReturnValue(true)
    mockDelete.mockResolvedValue({ ballots_deleted: 3 })
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))

    const receipt = await screen.findByRole('status', { name: /The row was deleted/ })
    expect(within(receipt).getByText(/the 3 ballots cast on it/)).toBeInTheDocument()
    expect(within(receipt).queryByText(/ballot\(s\)/)).toBeNull()
  })

  it('claims no number when the receipt could not be read', async () => {
    // The wire boundary answers 0 for a body it cannot parse, deliberately, rather than
    // failing a delete the server completed — so "0 ballots" is not a fact this page may
    // assert. The zero case gets its own sentence.
    mockIsAdmin.mockReturnValue(true)
    mockDelete.mockResolvedValue({ ballots_deleted: 0 })
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))

    const receipt = await screen.findByRole('status', { name: /The row was deleted/ })
    expect(within(receipt).getByText(/No ballot count was reported/)).toBeInTheDocument()
    expect(within(receipt).queryByText(/0 ballot/)).toBeNull()
  })

  it('lets a reader dismiss the receipt', async () => {
    mockIsAdmin.mockReturnValue(true)
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))
    const receipt = await screen.findByRole('status', { name: /The row was deleted/ })

    await user.click(within(receipt).getByRole('button', { name: /Dismiss this message/ }))

    expect(screen.queryByRole('status', { name: /The row was deleted/ })).toBeNull()
  })

  it('does not drop a reader on <body> when the receipt is dismissed', async () => {
    // THE ONE PATH WHERE THE ANCHOR IS GUARANTEED GONE. Dismissal restores focus to the
    // control that owns the write, and for a delete that is the row's own "Delete row"
    // button — which the completed delete unmounts along with the row. The receipt is
    // announce-only, so focus was never moved into it: a keyboard reader arrives by
    // tabbing to Dismiss, and dismissing unmounts the element focus is on. Declining to
    // claim focus therefore does not leave them where they were, it drops them on
    // `<body>` at the top of the document — measured, before the fallback existed.
    //
    // The page heading is where it lands instead: the one thing here that outlives any
    // row, and close enough that a tab from it reaches the rows.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores
      .mockResolvedValueOnce(twoRowRead())
      .mockResolvedValue({ rows: { [SECOND_ROW_ID]: secondRow() }, scores: {}, aggregates: {} })
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))
    const receipt = await screen.findByRole('status', { name: /The row was deleted/ })

    await user.click(within(receipt).getByRole('button', { name: /Dismiss this message/ }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Prioritization$/ })).toHaveFocus()
    })
    expect(document.body).not.toHaveFocus()
  })

  it('drops the deleted row from the next save, so the other rows survive it', async () => {
    // THE WRITE THIS PR MADE REACHABLE. `api_patch_prioritization_scores` checks every
    // named row exists before its first write and raises on any miss — deliberately, so
    // a body naming one vanished row persists nothing — so a pending edit left behind on
    // a deleted row refuses the WHOLE save and loses the edits on rows nobody touched.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores
      .mockResolvedValueOnce(twoRowRead())
      .mockResolvedValue({ rows: { [SECOND_ROW_ID]: secondRow() }, scores: {}, aggregates: {} })
    const { user } = await openTheRow()

    // An edit on the row about to be deleted, and one on the row that survives.
    fireEvent.change((await screen.findAllByRole('slider'))[0], { target: { value: '5' } })
    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))
    await waitFor(() => {
      expect(screen.queryByText(PRFAQ_TITLE)).toBeNull()
    })
    await user.click(screen.getByRole('button', { name: new RegExp(PRD_TITLE) }))
    fireEvent.change((await screen.findAllByRole('slider'))[0], { target: { value: '4' } })
    await user.click(screen.getByRole('button', { name: /Save/ }))

    await waitFor(() => {
      expect(mockPatchPrioritizationScores).toHaveBeenCalled()
    })
    // Only the surviving row is named, so the route has nothing to refuse the body over.
    const sent: unknown = mockPatchPrioritizationScores.mock.calls[0][0]
    expect(Object.keys(sent ?? {})).toEqual([SECOND_ROW_ID])
  })
})

describe("a project's only default row", () => {
  // The shape every project STARTS in: one row, minted by the default-row ensure. The
  // API refuses to delete it ("a project's default row cannot be deleted while it is the
  // project's only row"), so an offered control would invite an action that cannot work
  // behind a dialog naming an irreversible effect that will not occur.
  it('offers an admin no delete, and says why', async () => {
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue({
      rows: { [ROW_ID]: storedRow() }, scores: {}, aggregates: {},
    })

    await openTheRow()

    expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull()
    expect(screen.getByText(/only default row cannot be deleted/)).toBeInTheDocument()
  })

  it('offers the delete once the project holds a second row', async () => {
    // The other direction of the same gate, so it cannot pass by hiding the control
    // unconditionally.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue(twoRowRead())

    await openTheRow()

    expect(screen.getByRole('button', { name: /Delete row/ })).toBeInTheDocument()
    expect(screen.queryByText(/only default row cannot be deleted/)).toBeNull()
  })

  it('states no reason while the row count is still arriving', async () => {
    // THE COUNT IS ONLY AS COMPLETE AS THE READS BEHIND IT. Withholding the control while
    // one is in flight is recoverable — the reader waits and it appears — but the sentence
    // asserts a fact about stored state, and a reviewer who believes a false one acts on
    // it by adding a row they did not want. So the gate runs and the explanation does not.
    //
    // The scores read never settles here, which is the state the page is in for the whole
    // of the fan-out: the rows on screen come from the ensure route's own answer, so a row
    // renders while `scoresPending` is still true.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockReturnValue(new Promise(() => { /* never settles */ }))

    await openTheRow()

    // No control, because a default row that counts as its project's only one is one the
    // API refuses — the conservative direction for a courtesy gate.
    expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull()
    // And no claim about why, because the count is not settled enough to make one.
    expect(screen.queryByText(/only default row cannot be deleted/)).toBeNull()
  })

  it('states no reason when the scores read FAILED, where only default rows are known', async () => {
    // THE PATH THE PAGE DELIBERATELY SUPPORTS, and the one `!scoresPending` missed. A failed
    // scores read still lists the rows the ensure confirmed — rows are this page's whole
    // content — but rows only enter `ensuredRows` through `rowsAnswered`, and
    // `api_create_prioritization_row` answers a project's DEFAULT row and nothing else. A
    // row somebody COMPOSED has no path into it at all. So in this state every project reads
    // as holding exactly one row, and the sentence asserted "this is the project's only
    // default row" about projects that may hold three.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockRejectedValue(new Error('API Error: 500'))

    await openTheRow()

    // Withheld, which is recoverable — the reader reloads and it appears.
    expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull()
    // And nothing claimed about why, because nothing published a rows map to count.
    expect(screen.queryByText(/only default row cannot be deleted/)).toBeNull()
  })

  it('states no reason for a deployment that publishes no rows field', async () => {
    // The same blind spot with a 200 on it: a read that SUCCEEDED while sending no `rows`
    // field publishes no rows either, so `!scoresFailed` would not have covered it. What the
    // sentence needs is a read that actually DELIVERED a map — the same `rowsPublished`
    // signal `retainedEnsuredRows` is handed.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue({ scores: {}, aggregates: {} })

    await openTheRow()

    expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull()
    expect(screen.queryByText(/only default row cannot be deleted/)).toBeNull()
  })

  it('keeps the ensured fallback visible without settling its count when rows is unreadable', async () => {
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue({
      rows: 'garbage-not-a-map', scores: {}, aggregates: {},
    })

    await openTheRow()

    expect(screen.getByRole('button', { name: new RegExp(PRFAQ_TITLE) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull()
    expect(screen.queryByText(/only default row cannot be deleted/)).toBeNull()
  })

  it('keeps the ensured fallback visible without settling its count when rows is null', async () => {
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue({
      rows: null, scores: {}, aggregates: {},
    })

    await openTheRow()

    expect(screen.getByRole('button', { name: new RegExp(PRFAQ_TITLE) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull()
    expect(screen.queryByText(/only default row cannot be deleted/)).toBeNull()
  })

  it('keeps the ensured fallback visible without settling its count when rows is an array', async () => {
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue({
      rows: [], scores: {}, aggregates: {},
    })

    await openTheRow()

    expect(screen.getByRole('button', { name: new RegExp(PRFAQ_TITLE) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull()
    expect(screen.queryByText(/only default row cannot be deleted/)).toBeNull()
  })

  it('does not settle the count when a readable row map drops a malformed sibling', async () => {
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue({
      rows: {
        [ROW_ID]: storedRow(),
        malformed_sibling: 'garbage-not-a-row',
      },
      scores: {},
      aggregates: {},
    })

    await openTheRow()

    expect(screen.getByRole('button', { name: new RegExp(PRFAQ_TITLE) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull()
    expect(screen.queryByText(/only default row cannot be deleted/)).toBeNull()
  })

  it('counts a sibling row whose documents have not resolved, so it states nothing false', async () => {
    // `collectRows` DROPS a row not one of whose document ids resolves — an ordinary
    // transient state of the project fan-out, and the reachable way a project holding two
    // rows presented as holding one. Counting its output therefore reported the default
    // row as the project's only one and said so in words. The count is taken over the
    // rows themselves, BEFORE that narrowing.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue({
      rows: {
        [ROW_ID]: storedRow(),
        // A real second row of the same project, holding a document the project read on
        // screen does not (yet) name.
        [SECOND_ROW_ID]: secondRow({ document_ids: ['doc_not_yet_read'] }),
      },
      scores: {},
      aggregates: {},
    })

    await openTheRow()

    // Two rows exist, so the default row is deletable and nothing claims otherwise.
    expect(await screen.findByRole('button', { name: /Delete row/ })).toBeInTheDocument()
    expect(screen.queryByText(/only default row cannot be deleted/)).toBeNull()
  })

  it('offers the delete on a row the reviewer composed, whatever the project holds', async () => {
    // Only a DEFAULT row is refused as a project's last one, so a composed row is
    // deletable even when it is the only row a project has left.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue({
      rows: { [SECOND_ROW_ID]: secondRow() }, scores: {}, aggregates: {},
    })
    mockCreatePrioritizationRow.mockResolvedValue({
      success: true, created: false, row: secondRow(),
    })
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => {
      expect(screen.getByText(PRD_TITLE)).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: new RegExp(PRD_TITLE) }))

    expect(await screen.findByRole('button', { name: /Delete row/ })).toBeInTheDocument()
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
    // Two rows, so the delete is offered at all — see the "only default row" cases.
    mockGetPrioritizationScores.mockResolvedValue(twoRowRead())
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

  it('does not tell a reader to retry a compose the server REFUSED', async () => {
    // The 400 for more documents than a row may hold. The picker deliberately does not
    // enforce that bound — it is the server's — so this is the refusal the client
    // delegates, and "nothing was saved, so you can try again" is advice that cannot
    // work: the same selection gets the same answer.
    mockCompose.mockRejectedValue(new Error('API Error: 400'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Add row/ }))
    await user.click(screen.getByRole('button', { name: /Add the row/ }))

    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })
    expect(within(alert).getByText(/the request was refused rather than failing/i)).toBeInTheDocument()
    expect(within(alert).queryByText(/you can try again/i)).toBeNull()
  })

  it('does not tell a non-admin to retry a delete they may not perform', async () => {
    // `isPermanentRefusal` classifies 403 as retryable, which is right for the
    // row-ensure's silent retry (a WAF block, a lapsed token) and wrong for a sentence
    // in front of a person — see `isSettledRefusal`.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue(twoRowRead())
    mockDelete.mockRejectedValue(new Error('API Error: 403'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))

    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })
    // "may not be yours to do" — the permission named as one POSSIBILITY, since the
    // same sentence covers the 404 below.
    expect(within(alert).getByText(/may not be yours to do/i)).toBeInTheDocument()
    expect(within(alert).queryByText(/you can try again/i)).toBeNull()
  })

  it('does not blame permission for a delete of a row that is already gone', async () => {
    // `isSettledRefusal` routes every settled non-409 to the one `deleteRefused`
    // sentence, and 403 is not the only status that reaches it: 404 is what
    // `api_delete_prioritization_row` raises for a row another admin already removed,
    // and 400 for a malformed id. Copy asserting "this is an administrator's action"
    // therefore told a reader who HAS the permission to go and ask for one nobody can
    // grant — so the sentence names the possibilities and asserts none.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue(twoRowRead())
    mockDelete.mockRejectedValue(new Error('API Error: 404'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))

    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })
    // The settled sentence, and it offers the row already being gone as a reading.
    expect(within(alert).getByText(/the request was refused rather than failing/i)).toBeInTheDocument()
    expect(within(alert).getByText(/may already be gone/i)).toBeInTheDocument()
    // Not an assertion about permission, which is what would misdirect an admin.
    expect(within(alert).queryByText(/is an administrator's action/i)).toBeNull()
    expect(within(alert).queryByText(/you can try again/i)).toBeNull()
  })

  it('moves the reader to the failure, which is nowhere near the control that caused it', async () => {
    // Every control that produces this lives inside an expanded row that may be far
    // below the fold, while the panel renders near the top of the page. `role="alert"`
    // announces it to a screen reader and does nothing at all for a sighted reader, so
    // without this a refused write looks like a button that did nothing.
    //
    // Focus lands on the panel's HEADING rather than the region: focusing a live region
    // makes most screen readers announce it twice, once for the region changing and once
    // for focus landing on a container whose contents are then read.
    mockCompose.mockRejectedValue(new Error('API Error: 500'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Add row/ }))
    await user.click(screen.getByRole('button', { name: /Add the row/ }))

    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })
    await waitFor(() => {
      expect(within(alert).getByRole('heading', { name: /That change to the rows was not saved/ }))
        .toHaveFocus()
    })
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('puts focus back on the control that produced it when the panel is dismissed', async () => {
    // Dismissing unmounts the element focus is on, so without a restore a keyboard
    // reader is dropped on `<body>` at the top of the document and has to tab through
    // the whole page to reach the control inside the expanded row again.
    //
    // The anchor is the row's own "Delete row" button — the control that OWNS the write —
    // and not whatever was focused when the panel appeared: the confirm dialog's Confirm
    // unmounts in the same handler that issues the delete, so a restore aimed at it would
    // land on `<body>`. See `RowCompositionActions.onDelete`.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue(twoRowRead())
    mockDelete.mockRejectedValue(new Error('API Error: 500'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))
    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })
    await waitFor(() => {
      expect(within(alert).getByRole('heading', { name: /That change to the rows was not saved/ }))
        .toHaveFocus()
    })

    await user.click(within(alert).getByRole('button', { name: /Dismiss this message/ }))

    // Back on the row's own Delete control, and NOT dropped on `<body>` at the top of
    // the document.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Delete row/ })).toHaveFocus()
    })
    expect(document.body).not.toHaveFocus()
  })

  it('does not drop a reader on <body> when a failed COMPOSE is dismissed', async () => {
    // The case reading `document.activeElement` could never cover: the picker's Save
    // unmounts as it submits, so the element focus was on is already detached when the
    // panel appears and the restore was inert — measured as `document.body` having focus
    // after the dismissal. The anchor is the "Add row" button instead, which survives its
    // own submission because the picker renders below it.
    mockCompose.mockRejectedValue(new Error('API Error: 500'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Add row/ }))
    await user.click(screen.getByRole('button', { name: /Add the row/ }))
    const alert = await screen.findByRole('alert', { name: /That change to the rows was not saved/ })

    await user.click(within(alert).getByRole('button', { name: /Dismiss this message/ }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add row/ })).toHaveFocus()
    })
    expect(document.body).not.toHaveFocus()
  })

  it('leaves focus alone when the NEXT write clears the panel', async () => {
    // A GUARD ON THE NEW SHAPE rather than a reproduction of a measured defect, and worth
    // saying which. Restoring focus from the effect's cleanup ran on every teardown, not
    // only on a dismissal, so a reader who had moved on and then started another write was
    // liable to have focus pulled back to the previous write's anchor. In jsdom THIS case
    // passes against the cleanup version too — measured: the anchor there is the row's
    // Delete button, which `pending` has disabled by the time the cleanup fires, so the
    // restore no-ops. What this pins is that an explicit dismissal is the ONLY path that
    // claims focus, so widening it back into a teardown fails here.
    //
    // The clicks that clear the panel go through `fireEvent`, deliberately: `userEvent`
    // focuses what it clicks, so the reader's own focus has to be held constant for this
    // to measure the PANEL's behaviour rather than the click's.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue(twoRowRead())
    mockDelete.mockRejectedValue(new Error('API Error: 500'))
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))
    await screen.findByRole('alert', { name: /That change to the rows was not saved/ })

    // The reader moves on to the row's note, then a second write clears the panel.
    const note = screen.getByPlaceholderText(/notes about this prioritization/i)
    note.focus()
    fireEvent.click(screen.getByRole('button', { name: /Edit documents/ }))
    fireEvent.click(screen.getByRole('button', { name: /Save documents/ }))
    await waitFor(() => {
      expect(mockRecompose).toHaveBeenCalled()
    })

    // Wherever the reader put focus is where it stays — the panel's teardown claims
    // nothing.
    expect(note).toHaveFocus()
  })

  it('announces a delete that landed without taking focus from the reader', async () => {
    // A completed delete is the confirmation of something the reader asked for, so its
    // polite `role="status"` announcement is the right weight — and its own trigger is gone
    // with the row by definition. Taking focus as well would pull them off whatever
    // `ConfirmModal`'s restore has just handed back. It still scrolls into view.
    mockIsAdmin.mockReturnValue(true)
    mockGetPrioritizationScores.mockResolvedValue(twoRowRead())
    const { user } = await openTheRow()

    await user.click(screen.getByRole('button', { name: /Delete row/ }))
    await user.click(screen.getByRole('button', { name: /Delete row and ballots/ }))

    const receipt = await screen.findByRole('status', { name: /The row was deleted/ })
    const heading = within(receipt).getByRole('heading', { name: /The row was deleted/ })
    expect(heading).not.toHaveFocus()
    // Not left unreachable either: the panel brings itself into view for a sighted reader.
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
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
