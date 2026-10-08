/**
 * @fileoverview Shared mocks and data builders for the `src/pages/Prioritization` specs.
 *
 * Deliberately imports NO component from this directory: every page spec feeds the
 * module factories below into `vi.mock`, and a module that both feeds those factories
 * and imports a consumer of the mocked module cannot finish evaluating. Specs must
 * import this module BEFORE the component under test (or before
 * `./prioritization-render-fixtures`, which imports it).
 *
 * Usage, in a spec:
 *
 *   import { prioritizationMocks, projectsApiModule, clientApiModule } from './prioritization-fixtures'
 *   vi.mock('../../api/projectsApi', () => projectsApiModule())
 *   vi.mock('../../api/client', () => clientApiModule())
 *
 * The factory MUST be an arrow that calls the imported function — `vi.mock` is hoisted
 * above the import, so passing the function itself fails.
 */
import { createElement } from 'react'
import { vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * One `vi.fn()` per API the page reaches for, shared by every module factory.
 *
 * The three with a default implementation answer the way the specs that never vary
 * them used to stub inline (`Promise.resolve(...)`). `vi.clearAllMocks()` keeps an
 * implementation — it only forgets calls — so a default survives a spec's
 * `beforeEach`, exactly as the inline constant did.
 */
export const prioritizationMocks = {
  getProjects: vi.fn<() => Promise<unknown>>(),
  getProject: vi.fn<(projectId: string) => Promise<unknown>>(),
  /** The page's ONE batch read; its default answer is set just below. */
  getProjectDetails: vi.fn<(projectIds: readonly string[]) => Promise<unknown>>(),
  getPrioritizationScores: vi.fn<() => Promise<unknown>>(),
  // The page ensures a default row per project on mount, so nobody performs a setup
  // step. An absent stub is a TypeError that leaves the list empty.
  createPrioritizationRow: vi.fn<(projectId: string) => Promise<unknown>>(),
  patchPrioritizationScores: vi.fn<(scores: Record<string, Record<string, unknown>>) => Promise<unknown>>(
    () => Promise.resolve({ success: true }),
  ),
  getFeedbackForms: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ forms: [] })),
  getFeedbackFormStats: vi.fn<(formId: string) => Promise<unknown>>(
    () => Promise.resolve({ success: true, stats: null }),
  ),
  isAdmin: vi.fn<() => boolean>(() => false),
  composeRow: vi.fn<(input: unknown) => Promise<unknown>>(),
  recomposeRow: vi.fn<(rowId: string, input: unknown) => Promise<unknown>>(),
  deleteRow: vi.fn<(rowId: string) => Promise<unknown>>(),
}

/**
 * By default the batch answers from `getProject`, once per id, so every spec keeps
 * stubbing a project's documents where it always did; a spec about the batch itself
 * asserts on `getProjectDetails` (one call, every id). `vi.clearAllMocks()` keeps it.
 */
prioritizationMocks.getProjectDetails.mockImplementation((projectIds) => Promise.all(
  projectIds.map(async (id) => {
    const detail = await prioritizationMocks.getProject(id)
    return { project: { project_id: id }, ...(typeof detail === 'object' ? detail : {}) }
  }),
))

/**
 * Mutable so one spec can drive the page with an endpoint that cannot address a
 * form's public page. Each spec file gets its own module instance, so a change here
 * cannot leak between files; reset it in `beforeEach` when a case mutates it.
 */
export const mutableConfig = { apiEndpoint: 'https://api.example.com' }

// ---------------------------------------------------------------------------
// Module factories for `vi.mock`
// ---------------------------------------------------------------------------

export function projectsApiModule() {
  return {
    projectsApi: {
      getProjects: () => prioritizationMocks.getProjects(),
      getProject: (id: string) => prioritizationMocks.getProject(id),
      getProjectDetails: (ids: readonly string[]) => prioritizationMocks.getProjectDetails(ids),
    },
  }
}

function clientApiStubs() {
  return {
    getPrioritizationScores: () => prioritizationMocks.getPrioritizationScores(),
    patchPrioritizationScores: (scores: Record<string, Record<string, unknown>>) =>
      prioritizationMocks.patchPrioritizationScores(scores),
    createPrioritizationRow: (projectId: string) => prioritizationMocks.createPrioritizationRow(projectId),
    getFeedbackForms: () => prioritizationMocks.getFeedbackForms(),
    getFeedbackFormStats: (formId: string) => prioritizationMocks.getFeedbackFormStats(formId),
  }
}

export function clientApiModule() {
  return { api: clientApiStubs() }
}

/**
 * The REAL `client` module with only `api` replaced, for a spec whose tree also needs
 * another of its exports (`fetchApi`, which `votingSessionsApi` imports). Usage:
 * `vi.mock('../../api/client', async (importOriginal) => clientApiModuleOverOriginal(importOriginal))`.
 */
export async function clientApiModuleOverOriginal(importOriginal: () => Promise<Record<string, unknown>>) {
  return { ...await importOriginal(), api: clientApiStubs() }
}

export function prioritizationRowsApiModule() {
  return {
    prioritizationRowsApi: {
      composePrioritizationRow: (input: unknown) => prioritizationMocks.composeRow(input),
      recomposePrioritizationRow: (rowId: string, input: unknown) => prioritizationMocks.recomposeRow(rowId, input),
      deletePrioritizationRow: (rowId: string) => prioritizationMocks.deleteRow(rowId),
    },
  }
}

export function configStoreModule() {
  return { useConfigStore: () => ({ config: mutableConfig }) }
}

export function authStoreModule() {
  return { useIsAdmin: () => prioritizationMocks.isAdmin() }
}

export function reactMarkdownModule() {
  return { default: ({ children }: { children: string }) => createElement('div', null, children) }
}

// ---------------------------------------------------------------------------
// Data builders — the one-project, one-row shape the prototype and evidence specs use
// ---------------------------------------------------------------------------

export const HOUR_MS = 60 * 60_000
export const PROTOTYPE_PATH = 'https://d111.cloudfront.net/prototypes/p1/proto-1.html'
export const ROW_TITLE = 'Feature A PR/FAQ'
export const PROTOTYPE_TITLE = 'Feature A prototype'
/** The id the backend derives for project `p1`'s default row — see `rowId`. */
export const ROW_ID = 'row_p1_default'

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A signed URL for the prototype, with a distinct signature each time. */
export const signedUrl = (expiresAtMs: number, signature: string) =>
  `${PROTOTYPE_PATH}?Expires=${Math.floor(expiresAtMs / 1000)}&Signature=${signature}&Key-Pair-Id=K1`

export const project = {
  project_id: 'p1', name: 'Project 1', status: 'active',
  created_at: '2025-01-01', updated_at: '2025-01-01', persona_count: 0, document_count: 2,
}

export const prfaq = {
  document_id: 'doc_prfaq', document_type: 'prfaq', title: ROW_TITLE,
  content: '# Feature A', created_at: '2025-01-01',
}

/**
 * The project's one row, holding its one scorable document.
 *
 * `prototype_id` is deliberately EMPTY, so the row falls back to the project's
 * latest prototype — which is what the prototype specs vary. A row that named a
 * prototype id would pin them to one document and stop exercising the fallback.
 */
export const row = {
  row_id: ROW_ID,
  project_id: 'p1',
  document_ids: ['doc_prfaq'],
  prototype_id: '',
  is_default: true,
  created_at: '2025-01-01',
}

export const prototypeDoc = (prototypeUrl?: string) => ({
  document_id: 'proto-1',
  document_type: 'prototype',
  title: PROTOTYPE_TITLE,
  // New S3-only prototypes carry no inline content — the HTML is behind the URL.
  content: '',
  prototype_format: 'html',
  prototype_url: prototypeUrl,
  created_at: '2025-01-03',
})

/** A pre-migration prototype: inline HTML and no `prototype_url`, so nothing to open in a tab. */
export const legacyPrototypeDoc = () => ({
  ...prototypeDoc(), content: '<html><body>legacy</body></html>',
})

/** A prototype whose signature lapsed an hour ago. */
export const lapsedPrototypeDoc = () => prototypeDoc(signedUrl(Date.now() - HOUR_MS, 'sig-old'))

/** Answer the project read with the row's PR/FAQ plus `documents` — typically the one prototype a case varies. */
export function stubProjectHolding(...documents: readonly unknown[]) {
  prioritizationMocks.getProject.mockResolvedValue({ project_id: 'p1', documents: [prfaq, ...documents] })
}

/** A prototype signed for another hour, returning the address a case asserts against. */
export function stubFreshlySignedPrototype(): string {
  const url = signedUrl(Date.now() + HOUR_MS, 'sig-1')
  stubProjectHolding(prototypeDoc(url))
  return url
}

/**
 * The read every one-row spec starts from: the row, nobody's scores, and a project
 * whose prototype is signed for another hour.
 */
export function stubOneRowProject(
  documents: readonly unknown[] = [prfaq, prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1'))],
) {
  prioritizationMocks.getProjects.mockResolvedValue({ projects: [project] })
  prioritizationMocks.getPrioritizationScores.mockResolvedValue({ scores: {}, rows: { [row.row_id]: row } })
  prioritizationMocks.createPrioritizationRow.mockResolvedValue({ success: true, created: false, row })
  prioritizationMocks.getFeedbackForms.mockResolvedValue({ forms: [] })
  prioritizationMocks.getProject.mockResolvedValue({ project_id: 'p1', documents })
}

// ---------------------------------------------------------------------------
// Data builders — the many-project layout `Prioritization.test.tsx` drives
// ---------------------------------------------------------------------------

export const mockProjects = [
  { project_id: 'p1', name: 'Project 1', status: 'active', created_at: '2025-01-01', updated_at: '2025-01-01', persona_count: 2, document_count: 3 },
  { project_id: 'p2', name: 'Project 2', status: 'active', created_at: '2025-01-02', updated_at: '2025-01-02', persona_count: 1, document_count: 2 },
]

const mockProjectDetails = [
  {
    project_id: 'p1',
    documents: [
      { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '# Feature A\n\nThis is a great feature.', created_at: '2025-01-02' },
      { document_id: 'd2', document_type: 'prd', title: 'Feature A PRD', content: 'PRD content', created_at: '2025-01-01' },
    ],
  },
  {
    project_id: 'p2',
    documents: [
      { document_id: 'd3', document_type: 'prfaq', title: 'Feature B PR/FAQ', content: '# Feature B', created_at: '2025-01-02' },
    ],
  },
]

/**
 * The row id the backend derives for a project's default row.
 *
 * DERIVED, not minted — `_default_row_id` in `projects_handler.py` builds exactly
 * this from the project id, which is what makes asking for a default row twice
 * idempotent. Spelled here so a test can key a ballot or an aggregate the way the
 * page will look it up.
 */
const rowId = (projectId: string) => `row_${projectId}_default`

/** Which document types the backend composes a default row from. */
const SCORABLE = ['prd', 'prfaq']

interface LayoutDocument {
  readonly document_id: string
  readonly document_type: string
  readonly title: string
  readonly content?: string
  readonly created_at: string
}

interface ProjectDetail {
  readonly project_id: string
  readonly documents?: readonly { document_id: string; document_type: string; created_at?: string }[]
}

/**
 * One row per project, holding every scorable document that project has.
 *
 * The default composition, as the page receives it. A ROW IS A PROJECT: a project
 * whose PRD and PR/FAQ describe one idea gets ONE row here — so a test that wants N
 * rows on screen supplies N projects (see `oneRowPerDocument`), not N documents in
 * one project.
 */
function rowsFor(details: readonly ProjectDetail[]): Record<string, unknown> {
  const rows: Record<string, unknown> = {}
  for (const detail of details) {
    const documents = (detail.documents ?? []).filter((d) => SCORABLE.includes(d.document_type))
    if (documents.length === 0) continue
    const id = rowId(detail.project_id)
    rows[id] = {
      row_id: id,
      project_id: detail.project_id,
      document_ids: documents.map((d) => d.document_id),
      prototype_id: (detail.documents ?? []).find((d) => d.document_type === 'prototype')?.document_id ?? '',
      is_default: true,
      created_at: '2025-01-01',
    }
  }
  return rows
}

/**
 * N documents as N rows — one project each.
 *
 * For the many cases that need several INDEPENDENTLY SCORED rows on screen (the
 * sort, the stats cards, the save fan-out) and do not care which project each
 * belongs to. Putting them in one project would give one row, so the test would be
 * asserting about a list of one.
 *
 * Returns the pieces every harness needs: the projects list, a `getProject`
 * implementation, the rows map, and the row id per document so scores and
 * aggregates can be keyed the way the page reads them.
 */
export function oneRowPerDocument(documents: readonly LayoutDocument[]) {
  const details = documents.map((document, index) => ({
    project_id: `p${index + 1}`,
    documents: [{ content: '', ...document }],
  }))
  const projects = details.map((detail, index) => ({
    project_id: detail.project_id,
    name: `Project ${index + 1}`,
    status: 'active',
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
    persona_count: 0,
    document_count: 1,
  }))
  const rowIdOf: Record<string, string> = {}
  for (const detail of details) {
    for (const document of detail.documents) rowIdOf[document.document_id] = rowId(detail.project_id)
  }
  return {
    projects,
    getProject: (id: string) => Promise.resolve(
      details.find((detail) => detail.project_id === id) ?? { documents: [] },
    ),
    rows: rowsFor(details),
    rowIdOf,
  }
}

export type Layout = ReturnType<typeof oneRowPerDocument>

/**
 * The layout the CURRENT test installed, or `null` for the two-project default.
 *
 * A holder rather than two module-level bindings, so `R` and `DEFAULT_ROWS` below
 * can read the live value and a spec's `beforeEach` can clear it.
 */
const layoutState: { rows: Record<string, unknown> | null; rowOf: Record<string, string> | null } = {
  rows: null,
  rowOf: null,
}

const DEFAULT_ROW_OF: Record<string, string> = {
  d1: rowId('p1'), d2: rowId('p1'), d3: rowId('p2'),
}

/**
 * The row a given document lands on, under the CURRENT layout.
 *
 * `R.d1` is "the row holding d1". Written as a lookup rather than inlining
 * `rowId('p1')` at every call site because what the tests are ABOUT is the score or
 * the aggregate attached to a given document's row — the project each belongs to is
 * bookkeeping that `oneRowPerDocument` owns.
 *
 * A live lookup, not a constant: `oneRowPerDocument` hands each document its own
 * project in the order given, so which project holds `d1` depends on how the test
 * listed them. Resolving through the installed layout means a test can reorder its
 * documents without silently keying its scores to the wrong row — the failure that
 * would produce is a row that reads as unscored, which is easy to misread as a
 * product bug.
 *
 * Falls back to the two-project default, where `d1`/`d2` are p1's one row and `d3`
 * is p2's, for the cases that install no layout.
 *
 * One getter per document id the layouts use, so each read is a `string` — and a
 * read of a document the installed layout does not hold fails loudly instead of
 * keying a score to `undefined`.
 */
export const R = {
  get d1(): string { return rowOfDocument('d1') },
  get d2(): string { return rowOfDocument('d2') },
  get d3(): string { return rowOfDocument('d3') },
}

/** The row holding `documentId` (what `R.<documentId>` reads), failing loudly when the installed layout does not hold that document. */
function rowOfDocument(documentId: string): string {
  const rowOf = layoutState.rowOf ?? DEFAULT_ROW_OF
  const value = Object.hasOwn(rowOf, documentId) ? rowOf[documentId] : undefined
  if (value === undefined) throw new Error(`fixture: document ${documentId} is not in the layout`)
  return value
}

const currentRows = () => layoutState.rows ?? rowsFor(mockProjectDetails)

/**
 * The rows the CURRENT layout put on screen, for a response mock to echo back.
 *
 * A getter rather than a constant: `installLayout` runs per test and decides which
 * projects exist, and a mock written before it would freeze the previous test's
 * rows. Falling back to the two-project default covers the cases that install no
 * layout of their own.
 *
 * Rows are what make a row exist on the page at all — a response omitting them says
 * "this deployment has no rows yet", which renders the empty state rather than the
 * list under test.
 */
export const DEFAULT_ROWS = new Proxy<Record<string, unknown>>({}, {
  get: (_target, key) => currentRows()[String(key)],
  ownKeys: () => Reflect.ownKeys(currentRows()),
  getOwnPropertyDescriptor: (_t, key) => Reflect.getOwnPropertyDescriptor(currentRows(), key),
  has: (_t, key) => key in currentRows(),
})

/** Point the shared project mocks at a `oneRowPerDocument` layout. */
export function installLayout(layout: Layout): Layout {
  layoutState.rows = layout.rows
  layoutState.rowOf = layout.rowIdOf
  prioritizationMocks.getProjects.mockResolvedValue({ projects: layout.projects })
  prioritizationMocks.getProject.mockImplementation(layout.getProject)
  prioritizationMocks.createPrioritizationRow.mockImplementation((projectId: string) => Promise.resolve({
    success: true, created: false, row: layout.rows[rowId(projectId)],
  }))
  return layout
}

/** The one document most single-row cases score: `d1`, titled `ROW_TITLE`. */
const SINGLE_ROW_DOCUMENT: LayoutDocument = {
  document_id: 'd1', document_type: 'prfaq', title: ROW_TITLE, content: '', created_at: '2025-01-01',
}

/** Two independently scored rows, `d1` and `d3`, for the cases that need a sibling. */
export const TWO_ROW_DOCUMENTS: readonly LayoutDocument[] = [
  SINGLE_ROW_DOCUMENT,
  { document_id: 'd3', document_type: 'prfaq', title: 'Feature B PR/FAQ', content: '', created_at: '2025-01-02' },
]

/** One row on screen, `d1`, with the scores read left for the case to stub. */
export function installSingleRow(): Layout {
  return installLayout(oneRowPerDocument([SINGLE_ROW_DOCUMENT]))
}

/** One row on screen, `d1`, and a scores read answering `scoresPayload`. */
export function loadSingleRow(scoresPayload: unknown): Layout {
  const layout = installSingleRow()
  prioritizationMocks.getPrioritizationScores.mockResolvedValue(scoresPayload)
  return layout
}

/** A content-less PR/FAQ, for the layouts that only need titled rows. */
export function prfaqDocument(documentId: string, title: string, createdAt: string): LayoutDocument {
  return { document_id: documentId, document_type: 'prfaq', title, content: '', created_at: createdAt }
}

/** `entries` keyed by document id, re-keyed to the row each document lands on under `layout`. */
function keyedByRow<T>(layout: Layout, entries: Record<string, T>, value: (rowIdValue: string, entry: T) => unknown) {
  return Object.fromEntries(
    Object.entries(entries).map(([documentId, entry]) => {
      const rowIdValue = Object.hasOwn(layout.rowIdOf, documentId) ? layout.rowIdOf[documentId] : undefined
      if (rowIdValue === undefined) throw new Error(`fixture: document ${documentId} is not in the layout`)
      return [rowIdValue, value(rowIdValue, entry)]
    }),
  )
}

/**
 * One row per document, and a scores read carrying the team `aggregates` — KEYED BY
 * DOCUMENT id here, and re-keyed to the row each lands on, which is what the page
 * reads. `ownScores` likewise: the caller's unanimous ballot per document, at that value.
 */
export function loadRowsWithTeamAggregates(
  documents: readonly LayoutDocument[],
  aggregates: Record<string, unknown>,
  ownScores: Record<string, number> = {},
): Layout {
  const layout = installLayout(oneRowPerDocument(documents))
  prioritizationMocks.getPrioritizationScores.mockResolvedValue({
    rows: DEFAULT_ROWS,
    scores: keyedByRow(layout, ownScores, (rowIdValue, value) => unanimousBallot(rowIdValue, value)),
    aggregates: keyedByRow(layout, aggregates, (_rowIdValue, aggregate) => aggregate),
  })
  return layout
}

/** A team aggregate with every axis at `value`. */
export function unanimousAggregate(value: number, reviewerCount: number, scoreSpread = 0) {
  return {
    impact: value, time_to_market: value, confidence: value, strategic_fit: value,
    reviewer_count: reviewerCount, score_spread: scoreSpread,
  }
}

/** The caller's own ballot on `rowIdValue`, every axis at `value`. */
export function unanimousBallot(rowIdValue: string, value: number, notes = '') {
  return {
    row_id: rowIdValue, impact: value, time_to_market: value, confidence: value, strategic_fit: value, notes,
  }
}

/** The scores read fails outright — the endpoint raises rather than answering an empty map. */
export function givenTheScoresReadFails() {
  prioritizationMocks.getPrioritizationScores.mockRejectedValue(new Error('500'))
}

/**
 * One row scored top marks by the caller and 2.1 by the team.
 *
 * The team's axes are deliberately unequal, so its composite (2.1) is a value no
 * single axis on the row also renders — otherwise "the composite is on screen"
 * would be satisfied by an axis that happens to match it.
 */
export const disagreeingRead = () => {
  const d1Row = rowOfDocument('d1')
  return {
    rows: DEFAULT_ROWS,
    // The caller scored it top marks: composite 5.0.
    scores: { [d1Row]: unanimousBallot(d1Row, 5, 'mine') },
    // The team: 1*0.4 + 3*0.3 + 2*0.2 + 4*0.1 = 2.1.
    aggregates: {
      [d1Row]: {
        impact: 1, time_to_market: 3, confidence: 4, strategic_fit: 2,
        reviewer_count: 3, score_spread: 1.8,
      },
    },
  }
}

/** The page's default mocks: two projects as two rows, a scores read naming both, saves that succeed. */
export function resetPrioritizationPage(): void {
  vi.clearAllMocks()
  layoutState.rows = null
  layoutState.rowOf = null
  prioritizationMocks.getProjects.mockResolvedValue({ projects: mockProjects })
  prioritizationMocks.getProject.mockImplementation((id) => {
    const detail = mockProjectDetails.find(d => d.project_id === id)
    return Promise.resolve(detail ?? { documents: [] })
  })
  // Two projects, so two rows: p1's PRD and PR/FAQ are ONE row (named after the
  // newer document, the PR/FAQ) and p2's PR/FAQ is another.
  prioritizationMocks.getPrioritizationScores.mockResolvedValue({
    scores: {
      [rowId('p1')]: { row_id: rowId('p1'), impact: 0, time_to_market: 3, confidence: 0, strategic_fit: 0, notes: '' },
      [rowId('p2')]: { row_id: rowId('p2'), impact: 0, time_to_market: 3, confidence: 0, strategic_fit: 0, notes: '' },
    },
    rows: rowsFor(mockProjectDetails),
  })
  prioritizationMocks.createPrioritizationRow.mockImplementation((projectId: string) => Promise.resolve({
    success: true, created: false, row: rowsFor(mockProjectDetails)[rowId(projectId)],
  }))
  prioritizationMocks.patchPrioritizationScores.mockResolvedValue({ success: true, updated_count: 1 })
}
