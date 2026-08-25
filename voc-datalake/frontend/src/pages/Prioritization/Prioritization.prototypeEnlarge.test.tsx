/**
 * Enlarging a row's prototype to the whole viewport, and getting back (issue #314).
 *
 * A pitch session looks at the prototype in a pane sized to a table row. The
 * meeting exists to look at the artifact, so the row offers it at full size — and
 * without leaving the page, because the team's numbers, the reader's own sliders
 * and the room vote are all here and a new tab abandons them.
 *
 * Four properties are cheap to lose and invisible in review, so each is pinned by
 * a test that fails when it is reverted:
 *
 * 1. **The overlay is a dialog with a name, and focus goes into it.** A
 *    `fixed inset-0` div is the natural way to write this and the way 21 of the 23
 *    overlays audited for #283 were written; it leaves a keyboard user stranded
 *    behind the artifact.
 * 2. **It comes back — by the close control AND by Escape — and focus returns to
 *    the trigger.** An overlay that covers the row it was opened from is a trap if
 *    only the mouse can leave it.
 * 3. **It renders the ROW'S frame.** The overlay must show the same
 *    `HtmlPrototypeFrame` the row does, because that frame carries the signed-URL
 *    handling (`useLoadedUrl`) that turns a lapsed link into a readable message
 *    rather than a broken pane. A second frame implementation is what this asserts
 *    against, by pinning that the enlarged pane loads the row's signed address.
 * 4. **No prototype, no control.** The affordance and the artifact appear
 *    together; an enlarge button over an empty dialog is worse than no button.
 *
 * The open-in-a-new-tab anchor and the expiry note beside it are covered by
 * Prioritization.prototypeLink.test.tsx and are only re-checked here for the one
 * thing this change could plausibly have broken: that they are still there, still
 * an anchor, now that a button sits next to them.
 *
 * No fake timers, for the reason that suite states: the scheduling half of this
 * feature needs them and keeps them contained in
 * Prioritization.prototypeRefresh.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import i18n from 'i18next'

const mockGetProjects = vi.fn()
const mockGetProject = vi.fn()
const mockGetPrioritizationScores = vi.fn()
const mockCreatePrioritizationRow = vi.fn()
const mockGetFeedbackForms = vi.fn()

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
    getFeedbackForms: () => mockGetFeedbackForms(),
    getFeedbackFormStats: () => Promise.resolve({ success: true, stats: null }),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com' } }),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))

import Prioritization from './Prioritization'

const { t } = i18n
const HOUR_MS = 60 * 60_000
const PROTOTYPE_PATH = 'https://d111.cloudfront.net/prototypes/p1/proto-1.html'
const ROW_TITLE = 'Feature A PR/FAQ'
const PROTOTYPE_TITLE = 'Feature A prototype'

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const signedUrl = (expiresAtMs: number, signature: string) =>
  `${PROTOTYPE_PATH}?Expires=${Math.floor(expiresAtMs / 1000)}&Signature=${signature}&Key-Pair-Id=K1`

const project = {
  project_id: 'p1', name: 'Project 1', status: 'active',
  created_at: '2025-01-01', updated_at: '2025-01-01', persona_count: 0, document_count: 2,
}

const prfaq = {
  document_id: 'doc_prfaq', document_type: 'prfaq', title: ROW_TITLE,
  content: '# Feature A', created_at: '2025-01-01',
}

/** The project's one row. `prototype_id` empty, so it falls back to the latest prototype. */
const row = {
  row_id: 'row_p1_default',
  project_id: 'p1',
  document_ids: ['doc_prfaq'],
  prototype_id: '',
  is_default: true,
  created_at: '2025-01-01',
}

const prototypeDoc = (prototypeUrl?: string) => ({
  document_id: 'proto-1',
  document_type: 'prototype',
  title: PROTOTYPE_TITLE,
  content: '',
  prototype_format: 'html',
  prototype_url: prototypeUrl,
  created_at: '2025-01-03',
})

function renderPrioritization() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/', element: <Prioritization /> }])
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** Render the page and open the row — the prototype panel is expand-only. */
async function expandRow() {
  const user = userEvent.setup()
  renderPrioritization()
  await waitFor(() => {
    expect(screen.getByText(ROW_TITLE)).toBeInTheDocument()
  })
  await user.click(screen.getByText(ROW_TITLE))
  return user
}

const enlargeName = new RegExp(escapeRegExp(t('prioritization:preview.enlarge')), 'i')
const closeName = new RegExp(escapeRegExp(t('common:actions.close')), 'i')
const openLinkName = new RegExp(escapeRegExp(t('components:prototypeLink.openNewTab')), 'i')

/** Open the row, then the overlay, returning the trigger and the dialog. */
async function openOverlay() {
  const user = await expandRow()
  const trigger = await screen.findByRole('button', { name: enlargeName })
  await user.click(trigger)
  return { user, trigger, dialog: screen.getByRole('dialog') }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjects.mockResolvedValue({ projects: [project] })
  mockGetPrioritizationScores.mockResolvedValue({ scores: {}, rows: { [row.row_id]: row } })
  mockCreatePrioritizationRow.mockResolvedValue({ success: true, created: false, row })
  mockGetFeedbackForms.mockResolvedValue({ forms: [] })
  mockGetProject.mockResolvedValue({
    project_id: 'p1',
    documents: [prfaq, prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1'))],
  })
})

describe('offering to enlarge a row\'s prototype', () => {
  it('offers no enlarge control before the row is expanded', async () => {
    // The whole panel is expand-only: a page listing every project must not mount a
    // frame — or an affordance for one — per row at rest.
    renderPrioritization()

    await waitFor(() => {
      expect(screen.getByText(ROW_TITLE)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: enlargeName })).not.toBeInTheDocument()
  })

  it('offers no enlarge control for a row whose project has no prototype', async () => {
    mockGetProject.mockResolvedValue({ project_id: 'p1', documents: [prfaq] })

    await expandRow()

    // Wait for the expansion itself, so the absence below is an absence in a
    // rendered panel rather than in a panel that has not arrived.
    await waitFor(() => {
      expect(screen.getByText(t('prioritization:scores.title'))).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: enlargeName })).not.toBeInTheDocument()
    expect(screen.queryByText(enlargeName)).not.toBeInTheDocument()
  })

  it('offers the enlarge control for a legacy prototype, which has no address to open', async () => {
    // A pre-migration prototype is inline HTML with no `prototype_url`, so there is
    // nothing to open in a tab — but enlarging re-renders the pane the row already
    // shows, which needs no address. The two affordances answer the same question
    // and this is the row where only one of them can.
    mockGetProject.mockResolvedValue({
      project_id: 'p1',
      documents: [prfaq, { ...prototypeDoc(undefined), content: '<html><body>legacy</body></html>' }],
    })

    await expandRow()

    expect(await screen.findByRole('button', { name: enlargeName })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: openLinkName })).not.toBeInTheDocument()
  })

  it('leaves opening in a new tab a plain anchor beside the enlarge control', async () => {
    // A button now sits next to the anchor, and the temptation is to make the pair
    // consistent by turning the anchor into a button too. That trades a 403 for a
    // popup blocker — see components/prototypeLinkLifetime.
    const url = signedUrl(Date.now() + HOUR_MS, 'sig-1')
    mockGetProject.mockResolvedValue({ project_id: 'p1', documents: [prfaq, prototypeDoc(url)] })

    await expandRow()

    expect(await screen.findByRole('link', { name: openLinkName })).toHaveAttribute('href', url)
    expect(screen.queryByRole('button', { name: openLinkName })).not.toBeInTheDocument()
    // And the expiry stays visible beside it, rather than being displaced by the
    // new control.
    expect(screen.getByText(/tied to your session, not a share link/i)).toBeInTheDocument()
  })

  it('renders nothing enlarged until the control is used', async () => {
    await expandRow()

    await screen.findByRole('button', { name: enlargeName })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('the enlarged prototype', () => {
  it('exposes itself as a modal dialog named after the prototype', async () => {
    const { dialog } = await openOverlay()

    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // Non-empty and derived from the heading on screen, so the name cannot drift
    // from what a sighted viewer reads.
    expect(dialog).toHaveAccessibleName(
      new RegExp(`${escapeRegExp(t('prioritization:preview.prototypeTitle'))}.*${escapeRegExp(PROTOTYPE_TITLE)}`),
    )
  })

  it('moves focus into the dialog when it opens', async () => {
    const { dialog } = await openOverlay()

    expect(dialog).toContainElement(document.activeElement as HTMLElement)
  })

  it('renders the row\'s own frame at the row\'s signed address', async () => {
    // The property that says "not a second frame implementation": the enlarged pane
    // is an iframe loading the same signed URL the row's pane does, and there are
    // now two of them for the one document. A bespoke overlay renderer — a fetch, a
    // blob, a rebuilt URL — fails this.
    const url = signedUrl(Date.now() + HOUR_MS, 'sig-1')
    mockGetProject.mockResolvedValue({ project_id: 'p1', documents: [prfaq, prototypeDoc(url)] })

    const { dialog } = await openOverlay()

    const enlarged = within(dialog).getByTitle(PROTOTYPE_TITLE)
    expect(enlarged.tagName).toBe('IFRAME')
    expect(enlarged).toHaveAttribute('src', url)
    expect(screen.getAllByTitle(PROTOTYPE_TITLE)).toHaveLength(2)
  })

  it('reports a lapsed link inside the overlay rather than showing a broken pane', async () => {
    // Same degradation the row's pane gets, and the reason the overlay reuses the
    // row's frame: an expired signature is announced by `HtmlPrototypeFrame`'s own
    // handling, so the overlay inherits it instead of re-deciding it.
    mockGetProject.mockResolvedValue({
      project_id: 'p1', documents: [prfaq, prototypeDoc(signedUrl(Date.now() - HOUR_MS, 'sig-old'))],
    })

    const { dialog } = await openOverlay()

    // The row says so, in the note beside the anchor…
    expect(screen.getByText(/Link expired/)).toBeInTheDocument()
    // …and the overlay still renders through the same frame, which is what carries
    // that behaviour, rather than an empty box or a bespoke error of its own.
    expect(within(dialog).getByTitle(PROTOTYPE_TITLE).tagName).toBe('IFRAME')
  })
})

describe('getting back to the row', () => {
  it('closes on the close control and returns focus to the enlarge control', async () => {
    const { user, trigger, dialog } = await openOverlay()

    await user.click(within(dialog).getByRole('button', { name: closeName }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Focus back where it started: the overlay covered the row, so a keyboard user
    // dropped at the top of the page has lost their place in a long list.
    expect(trigger).toHaveFocus()
  })

  it('closes on Escape and returns focus to the enlarge control', async () => {
    const { user, trigger } = await openOverlay()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('leaves the row expanded underneath, so the ballot is still there on return', async () => {
    // The reason this is an overlay and not a new tab: the sliders, the team's
    // numbers and the room vote are on this page.
    const { user } = await openOverlay()

    await user.keyboard('{Escape}')

    expect(screen.getByText(t('prioritization:scores.title'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: enlargeName })).toBeInTheDocument()
  })

  it('can be reopened after closing', async () => {
    const { user, trigger } = await openOverlay()

    await user.keyboard('{Escape}')
    await user.click(trigger)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
