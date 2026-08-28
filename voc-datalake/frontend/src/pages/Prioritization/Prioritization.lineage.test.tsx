/**
 * What the page SHOWS about a row's evidence: which lineage state it is in, why,
 * and — for a frozen row the project has moved past — where to go instead.
 *
 * These drive the whole page rather than a component in isolation, deliberately:
 * the lineage is resolved in `collectRows` from the row's stored ids and the
 * project read, so a case that constructed a `PrioritizationRowView` by hand would
 * assert the badge and prove nothing about what any real row displays. The
 * classifier's own rules are pinned at their seam in `rowLineage.test.ts`; this
 * file is about the presentation and the wiring.
 *
 * REVERT MAP — which case catches which revert:
 *
 *  * `<RowLineageBadge>` removed from the header → "the resting row states which
 *    lineage state it is in";
 *  * the badge's `sr-only` reason dropped to `title` alone → "the reason is
 *    announced, not only hovered" (a `title` never appears on touch and is
 *    announced inconsistently);
 *  * one state's `LINEAGE_STYLE` entry pointed at another's → "each state reads as
 *    itself" (which compares the three rendered labels rather than one spelling);
 *  * `<RowStaleBadge>` removed, or its `is_frozen` gate lost → "a frozen row whose
 *    documents were superseded says so" and "a current frozen row does not";
 *  * `fresherCoherentSelection`'s candidate condition tightened to require a
 *    `coherent` candidate → "says so on a project where NO document records its
 *    lineage" (which is every pre-`derivation` deployment, so the badge was
 *    unreachable there);
 *  * `<RowLineageNote>`'s stale sentence removed → "a stale row names Add row as
 *    the action";
 *  * the `{ action: t('composition.addRow') }` interpolation dropped from that
 *    sentence → the same case, which reads the label off the rendered BUTTON rather
 *    than off a second copy of it in the catalogue;
 *  * anything that gated a control on lineage → "every lineage state stays
 *    scorable and keeps its composition controls", and the stale case's assertion
 *    that the frozen row's document badges are unchanged;
 *  * `lineage` derived from "the latest of each type" rather than the row's stored
 *    ids → "a stale frozen row still shows the documents its ballots were cast
 *    on".
 */
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest'
import {
  cleanup, render, screen, within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import i18n from 'i18next'

const mockGetProjects = vi.fn()
const mockGetProject = vi.fn()
const mockGetPrioritizationScores = vi.fn()
const mockCreatePrioritizationRow = vi.fn()

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

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com' } }),
}))

vi.mock('../../store/authStore', () => ({
  useIsAdmin: () => false,
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))

import Prioritization from './Prioritization'

const ROW_ID = 'row_p1_default'

const project = {
  project_id: 'p1',
  name: 'Project 1',
  status: 'active',
  created_at: '2025-01-01',
  updated_at: '2025-01-01',
  persona_count: 0,
  document_count: 2,
}

/** A derivation recording feedback and no source — lineage present, nothing crossed. */
const fromFeedback = {
  derivation: {
    sources: [],
    selected_document_count: 0,
    feedback_count: 9,
    persona_ids: [],
    visual_document_ids: [],
    product_context_included: false,
  },
}

/** A declared derivation naming one source document in the reference role. */
const fromDocument = (id: string) => ({
  derivation: {
    sources: [{ document_id: id, role: 'reference' }],
    selected_document_count: 1,
    feedback_count: 0,
    persona_ids: [],
    visual_document_ids: [],
    product_context_included: false,
  },
})

/**
 * One project document, as the project read supplies it.
 *
 * `derivation` is declared OPTIONAL rather than inferred, because the two shapes a
 * case needs are on opposite sides of that: `extra` carries the field for a document
 * that records its lineage, and the legacy fixtures strip it off again for one that
 * cannot. Inferred from the literal, the spread of `extra` leaves the field
 * statically unknown, and destructuring it off is a `typecheck:tests` error (TS2339)
 * even though it is exactly the right runtime operation. Optional and not
 * `unknown`-valued, so a stripped fixture OMITS the key rather than setting it to
 * `undefined` — which is what the lineage-absent cases assert about.
 */
interface FixtureDocument {
  readonly document_id: string
  readonly document_type: string
  readonly title: string
  readonly content: string
  readonly created_at: string
  readonly derivation?: unknown
}

const doc = (
  id: string,
  type: string,
  title: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
): FixtureDocument => ({
  document_id: id,
  document_type: type,
  title,
  content: `${title} body`,
  created_at: createdAt,
  ...extra,
})

/** The first generation of the project's two scorable documents. */
const PRD_1 = doc('doc_prd_1', 'prd', 'Instant refunds PRD', '2025-01-01', fromFeedback)
const PRFAQ_1 = doc('doc_prfaq_1', 'prfaq', 'Instant refunds PR/FAQ', '2025-01-01', fromFeedback)
/** The second, generated two months later from the same feedback. */
const PRD_2 = doc('doc_prd_2', 'prd', 'Instant refunds PRD v2', '2025-03-01', fromFeedback)
const PRFAQ_2 = doc('doc_prfaq_2', 'prfaq', 'Instant refunds PR/FAQ v2', '2025-03-01', fromFeedback)

const storedRow = (overrides: Record<string, unknown> = {}) => ({
  row_id: ROW_ID,
  project_id: 'p1',
  document_ids: [PRFAQ_1.document_id, PRD_1.document_id],
  prototype_id: '',
  is_default: true,
  created_at: '2025-01-01',
  is_frozen: false,
  ...overrides,
})

/** Drive the page with one project holding `documents` and one row holding `row`. */
function givenProject(documents: readonly unknown[], row: Record<string, unknown>) {
  mockGetProject.mockResolvedValue({ project_id: 'p1', documents })
  mockGetPrioritizationScores.mockResolvedValue({
    rows: { [ROW_ID]: row },
    scores: {},
    aggregates: {},
  })
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/', element: <Prioritization /> }])
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** The one lineage badge on screen, once the row has rendered. */
async function lineageBadge(): Promise<HTMLElement> {
  renderPage()
  return screen.findByTestId('row-lineage')
}

/**
 * Render, wait for the row and expand it — the note and the composition controls
 * both live inside the expansion.
 *
 * The row's own leading document names its header button, so the title is a
 * parameter: a case whose row holds a different document than the default one
 * would otherwise fail to find the header rather than failing its assertion.
 */
async function openTheRow(rowTitle: string = PRFAQ_1.title): Promise<HTMLElement> {
  const user = userEvent.setup()
  renderPage()
  const badge = await screen.findByTestId('row-lineage')
  await user.click(screen.getByRole('button', { name: new RegExp(escapeForName(rowTitle)) }))
  await screen.findByTestId(`row-composition-${ROW_ID}`)
  return badge
}

/** A document title as a safe fragment of a `RegExp` — titles carry `/` and `.`. */
function escapeForName(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

const t = (key: string) => i18n.t(key, { ns: 'prioritization' })

/**
 * The stale sentence as the note renders it — the Add-row label interpolated.
 *
 * A helper rather than a literal in each case, because the two absence cases below
 * must look for the SAME string the presence case finds: an `{{action}}` left
 * uninterpolated would make "the sentence is not here" trivially true and both
 * negative cases vacuous.
 */
const staleAction = (): string => i18n.t('lineage.staleAction', {
  ns: 'prioritization',
  action: t('composition.addRow'),
})

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjects.mockResolvedValue({ projects: [project] })
  mockCreatePrioritizationRow.mockResolvedValue({
    success: true, created: false, row: storedRow(),
  })
  givenProject([PRD_1, PRFAQ_1], storedRow())
})

describe('the resting row states what its documents say about each other', () => {
  it('reads as one generation when the row holds a matching PRD and PR/FAQ', async () => {
    const badge = await lineageBadge()

    expect(badge).toHaveAttribute('data-lineage', 'coherent')
    expect(badge).toHaveTextContent(t('lineage.coherent'))
  })

  it('reads as crossing generations when the row holds two versions of one type', async () => {
    givenProject([PRD_1, PRD_2, PRFAQ_1], storedRow({
      document_ids: [PRD_2.document_id, PRD_1.document_id],
    }))

    const badge = await lineageBadge()

    expect(badge).toHaveAttribute('data-lineage', 'crossGeneration')
    expect(badge).toHaveTextContent(t('lineage.crossGeneration'))
  })

  it('reads as lineage-absent when no document records what it was built from', async () => {
    // Every project document created before the `derivation` field existed, and every
    // hand-authored one. Not an error, and not a claim that anything crosses.
    const legacyPrd = doc('doc_prd_1', 'prd', 'Instant refunds PRD', '2025-01-01')
    const legacyPrfaq = doc('doc_prfaq_1', 'prfaq', 'Instant refunds PR/FAQ', '2025-01-01')
    givenProject([legacyPrd, legacyPrfaq], storedRow())

    const badge = await lineageBadge()

    expect(badge).toHaveAttribute('data-lineage', 'absent')
    expect(badge).toHaveTextContent(t('lineage.absent'))
  })

  it('gives each state its own words, so none is told apart by colour alone', async () => {
    // Three renders, three labels, compared against EACH OTHER rather than against one
    // spelling: a table entry pointed at a neighbour's key would still render a
    // plausible label, and each of the cases above would still pass.
    const labels: string[] = []
    for (const [documents, row] of [
      [[PRD_1, PRFAQ_1], storedRow()],
      [[PRD_1, PRD_2], storedRow({ document_ids: [PRD_2.document_id, PRD_1.document_id] })],
      [
        [doc('doc_prd_1', 'prd', 'Legacy PRD', '2025-01-01')],
        storedRow({ document_ids: ['doc_prd_1'] }),
      ],
    ] as const) {
      givenProject(documents, row)
      const badge = await lineageBadge()
      labels.push(badge.textContent ?? '')
      // Unmounted between renders, so the next `findByTestId` cannot match the
      // previous row's badge and report three renders of one state as three states.
      cleanup()
    }

    expect(new Set(labels).size).toBe(3)
  })

  it('announces the reason rather than only hovering it', async () => {
    // A `title` never appears on a touch device and screen-reader support for it is
    // inconsistent — the trap `SortControls` records for its own hint — so the reason
    // is in the accessible text as well.
    const badge = await lineageBadge()

    expect(badge).toHaveAttribute('title', t('lineage.coherentReason'))
    expect(badge).toHaveTextContent(t('lineage.coherentReason'))
  })

  it('prints the reason in full inside the expansion', async () => {
    // Where the sighted reader reads it: the header's copy is announced only, because a
    // sentence per row there would bury the numbers beside it.
    await openTheRow()

    expect(within(screen.getByTestId('row-lineage-note')).getByText(t('lineage.coherentReason')))
      .toBeInTheDocument()
  })

  it('keeps every state scorable, with its composition controls intact', async () => {
    // The criterion the whole signal is bounded by. The worst-evidence row — nothing
    // records anything — still offers four sliders, a note, and both composition
    // controls: lineage describes a row, it never gates one.
    const legacyPrd = doc('doc_prd_1', 'prd', 'Legacy PRD', '2025-01-01')
    givenProject([legacyPrd], storedRow({ document_ids: ['doc_prd_1'] }))

    const badge = await openTheRow(legacyPrd.title)

    expect(badge).toHaveAttribute('data-lineage', 'absent')
    expect(await screen.findAllByRole('slider')).toHaveLength(4)
    for (const name of [/Edit documents/, /Add row/]) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }
  })
})

describe('a frozen row whose project has moved on', () => {
  /** The project holds both generations; the frozen row holds the first. */
  const bothGenerations = [PRD_1, PRFAQ_1, PRD_2, PRFAQ_2]

  it('says the documents behind it have been superseded', async () => {
    givenProject(bothGenerations, storedRow({ is_frozen: true }))

    renderPage()
    const stale = await screen.findByTestId('row-stale')

    expect(stale).toHaveTextContent(t('lineage.stale'))
    // Announced as well as hovered, like the lineage reason beside it.
    expect(stale).toHaveAttribute('title', t('lineage.staleReason'))
    expect(stale).toHaveTextContent(t('lineage.staleReason'))
    // And it is still described as coherent: staleness is a second axis, so a
    // superseded row that is internally consistent is not relabelled as incoherent.
    expect(await screen.findByTestId('row-lineage')).toHaveAttribute('data-lineage', 'coherent')
  })

  it('directs the reviewer to Add row, with the frozen row and its documents untouched', async () => {
    givenProject(bothGenerations, storedRow({ is_frozen: true }))

    await openTheRow()

    // The advice, next to the control it names — and naming it with the label that
    // control actually renders. `composition.addRow` is interpolated rather than
    // restated per locale, so the sentence and the button cannot drift apart the way
    // zh's copy already had.
    const addRow = screen.getByRole('button', { name: /Add row/ })
    const action = staleAction()
    const note = within(screen.getByTestId('row-lineage-note'))
    expect(note.getByText(action)).toBeInTheDocument()
    // Not merely "the string i18next produced": the label the sentence names is read
    // off the rendered BUTTON, so a sentence pointing at a control by some other name
    // fails here. Non-vacuous — the button's name is non-empty and the raw key would
    // not contain it.
    expect(addRow.textContent?.trim()).toBeTruthy()
    expect(note.getByText(action)).toHaveTextContent(addRow.textContent?.trim() ?? '')
    expect(addRow).toBeEnabled()
    // The frozen row is UNCHANGED: it still shows the documents its ballots were cast
    // on, not the fresher ones, and it says why its composition is locked. Silently
    // re-pointing it is the defect the row model exists to prevent.
    const panel = screen.getByTestId(`row-composition-${ROW_ID}`)
    expect(within(panel).getByText(t('composition.locked'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit documents/ })).toBeNull()
    // `getAllBy`, because the row's own title appears in the header AND on the
    // document it names inside the expansion — which is the point: both are the
    // FIRST generation.
    expect(screen.getAllByText(PRFAQ_1.title).length).toBeGreaterThan(0)
    expect(screen.queryByText(PRFAQ_2.title)).toBeNull()
    expect(screen.queryByText(PRD_2.title)).toBeNull()
    // Still scorable — freezing the composition never froze the ballot.
    expect(await screen.findAllByRole('slider')).toHaveLength(4)
  })

  it('says nothing of the sort for a frozen row holding the newest of each type', async () => {
    givenProject(bothGenerations, storedRow({
      is_frozen: true,
      document_ids: [PRFAQ_2.document_id, PRD_2.document_id],
    }))

    renderPage()
    await screen.findByTestId('row-lineage')

    expect(screen.queryByTestId('row-stale')).toBeNull()
    expect(screen.queryByText(staleAction())).toBeNull()
  })

  it('says nothing of the sort for an UN-frozen row, which can simply be edited', async () => {
    // Same project, same documents, same row — only the freeze differs. An un-frozen
    // row's answer is "edit this one", which is on screen already, so "add a row" would
    // be advice to take the long way round.
    givenProject(bothGenerations, storedRow({ is_frozen: false }))

    await openTheRow()

    expect(screen.queryByTestId('row-stale')).toBeNull()
    expect(screen.queryByText(staleAction())).toBeNull()
    // The control that makes "add a row" the wrong advice here.
    expect(screen.getByRole('button', { name: /Edit documents/ })).toBeInTheDocument()
  })

  it('says nothing of the sort when the fresher combination itself crosses generations', async () => {
    // "Newest of each type" is not automatically one generation: this project's newest
    // PR/FAQ was built from the OLD PRD. Trading a stale row for an incoherent one is
    // not an improvement, so no advice is given.
    const crossingPrfaq2 = doc(
      'doc_prfaq_2', 'prfaq', 'Instant refunds PR/FAQ v2', '2025-03-01',
      fromDocument(PRD_1.document_id),
    )
    givenProject([PRD_1, PRFAQ_1, PRD_2, crossingPrfaq2], storedRow({ is_frozen: true }))

    renderPage()
    await screen.findByTestId('row-lineage')

    expect(screen.queryByTestId('row-stale')).toBeNull()
  })

  it('says so on a project where NO document records its lineage', async () => {
    // The population that actually HAS superseded frozen rows: a deployment old
    // enough to hold one is old enough that its early documents predate the
    // `derivation` field. Every document here omits it, so the row AND the
    // newest-of-each candidate both classify as `absent` — and while the candidate
    // had to be `coherent`, the stale badge never reached this project at all.
    //
    // Driven through the page rather than only at the classifier's seam because that
    // is what the user-visible claim is: the badge is on screen, and it is on screen
    // beside a row the page still describes as lineage-absent.
    const legacy = [PRD_1, PRFAQ_1, PRD_2, PRFAQ_2].map(
      ({ derivation: _derivation, ...rest }) => rest,
    )
    givenProject(legacy, storedRow({ is_frozen: true }))

    renderPage()

    expect(await screen.findByTestId('row-stale')).toHaveTextContent(t('lineage.stale'))
    // Absent, not coherent: the fix loosened WHICH candidate may be advised, and did
    // not reclassify anything. A case asserting only the badge could pass if the
    // documents had quietly kept their derivation.
    expect(await screen.findByTestId('row-lineage')).toHaveAttribute('data-lineage', 'absent')
  })

  it('does not call a row stale for a document type it never held', async () => {
    // The missing-optional-document boundary: a row scored on a PR/FAQ alone is
    // compared with the newest PR/FAQ alone, so the project gaining a PRD is "you
    // could have picked more" rather than "your evidence is superseded".
    givenProject([PRFAQ_1, PRD_2], storedRow({
      is_frozen: true,
      document_ids: [PRFAQ_1.document_id],
    }))

    renderPage()
    await screen.findByTestId('row-lineage')

    expect(screen.queryByTestId('row-stale')).toBeNull()
  })
})
