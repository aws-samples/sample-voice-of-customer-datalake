/**
 * Opening a row's prototype outside the app, and what the row says about how long
 * that keeps working.
 *
 * The embedded frame is 384px inside half a row, which is enough to recognise a
 * prototype and not enough to walk a room through one — so the row offers it in a
 * new tab. Three properties of that affordance are cheap to lose and invisible in
 * review, so all three are pinned here:
 *
 * 1. **It is an anchor.** A prototype URL is a signed credential, so the obvious
 *    "improvement" is a button that fetches a fresh signature and then calls
 *    `window.open`. That trades a 403 for a popup blocker (see
 *    components/prototypeLinkLifetime). A `getByRole('link')` assertion is what
 *    makes that rewrite fail instead of shipping.
 * 2. **The deadline is stated.** A link that silently dies is the failure mode this
 *    guards, and it must be visible text rather than a tooltip.
 * 3. **A row with no prototype offers nothing.** Most rows have no prototype, and
 *    an anchor pointing at `undefined` is worse than no anchor.
 *
 * No fake timers: the expired branch is chosen by putting `Expires` either side of
 * the real clock. The scheduling half of this feature needs timers and lives in
 * Prioritization.prototypeRefresh.test.tsx, so they stay contained there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import i18n from 'i18next'

const mockGetProjects = vi.fn()
const mockGetProject = vi.fn()
const mockGetPrioritizationScores = vi.fn()
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
import { formatExpiry } from '../../components/prototypeLinkLifetime'

const { t } = i18n
const HOUR_MS = 60 * 60_000
const PROTOTYPE_PATH = 'https://d111.cloudfront.net/prototypes/p1/proto-1.html'
const ROW_TITLE = 'Feature A PR/FAQ'

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A signed URL for the prototype, with a distinct signature each time. */
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

const prototypeDoc = (prototypeUrl?: string) => ({
  document_id: 'proto-1',
  document_type: 'prototype',
  title: 'Feature A prototype',
  // New S3-only prototypes carry no inline content — the HTML is behind the URL.
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
}

const openLinkName = new RegExp(escapeRegExp(t('components:prototypeLink.openNewTab')), 'i')
const downloadLinkName = new RegExp(escapeRegExp(t('components:prototypeLink.downloadHtml')), 'i')

/**
 * Nothing offering to open the prototype, by TEXT and not only by role.
 *
 * Both, because they fail in different directions. Role alone misses an affordance
 * rendered with a broken address: `<a href="">` loses the `link` role in
 * aria-query, so a regression that offered "Open in new tab" pointing nowhere would
 * pass a role-only assertion while being exactly the defect worth catching.
 */
function expectNoOpenAffordance(): void {
  expect(screen.queryByRole('link', { name: openLinkName })).not.toBeInTheDocument()
  expect(screen.queryByText(openLinkName)).not.toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjects.mockResolvedValue({ projects: [project] })
  mockGetPrioritizationScores.mockResolvedValue({ scores: {} })
  mockGetFeedbackForms.mockResolvedValue({ forms: [] })
  mockGetProject.mockResolvedValue({
    project_id: 'p1',
    documents: [prfaq, prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1'))],
  })
})

describe('opening a row\'s prototype in a new tab', () => {
  it('offers the prototype as a plain anchor at its signed address', async () => {
    const url = signedUrl(Date.now() + HOUR_MS, 'sig-1')
    mockGetProject.mockResolvedValue({ project_id: 'p1', documents: [prfaq, prototypeDoc(url)] })

    await expandRow()

    // A LINK, not a button. A button that fetched a fresh signature and then called
    // window.open would be blocked as a popup — freshness is the scheduler's job.
    const link = await screen.findByRole('link', { name: openLinkName })
    expect(link).toHaveAttribute('href', url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(screen.queryByRole('button', { name: openLinkName })).not.toBeInTheDocument()
  })

  it('offers no open affordance for a row whose project has no prototype', async () => {
    mockGetProject.mockResolvedValue({ project_id: 'p1', documents: [prfaq] })

    await expandRow()

    await waitFor(() => {
      expect(screen.getByText(t('prioritization:scores.title'))).toBeInTheDocument()
    })
    expectNoOpenAffordance()
  })

  it('offers no open affordance for a legacy prototype, which has no address', async () => {
    // Pre-migration prototypes are inline HTML with no `prototype_url`. They still
    // preview in the frame; there is simply nothing to open.
    mockGetProject.mockResolvedValue({
      project_id: 'p1',
      documents: [prfaq, { ...prototypeDoc(undefined), content: '<html><body>legacy</body></html>' }],
    })

    await expandRow()

    await waitFor(() => {
      expect(screen.getByText(t('prioritization:scores.title'))).toBeInTheDocument()
    })
    expectNoOpenAffordance()
  })

  it('leaves downloading to the project page, which is where artifacts are filed', async () => {
    await expandRow()

    await screen.findByRole('link', { name: openLinkName })
    expect(screen.queryByRole('link', { name: downloadLinkName })).not.toBeInTheDocument()
    expect(screen.queryByText(downloadLinkName)).not.toBeInTheDocument()
  })
})

describe('what the row says about the prototype link\'s lifetime', () => {
  it('states when the link stops working', async () => {
    const expiresAt = Date.now() + HOUR_MS
    mockGetProject.mockResolvedValue({
      project_id: 'p1', documents: [prfaq, prototypeDoc(signedUrl(expiresAt, 'sig-1'))],
    })

    await expandRow()

    // Formatted the way the component does, so this holds in any timezone and under
    // any locale rather than only the one the suite happens to run in.
    const expected = formatExpiry(Math.floor(expiresAt / 1000) * 1000, Date.now(), 'en')
    expect(await screen.findByText(
      new RegExp(`Link valid until ${escapeRegExp(expected)}`),
    )).toBeInTheDocument()
  })

  it('says the link is session-scoped in VISIBLE text, not a tooltip', async () => {
    await expandRow()

    expect(await screen.findByText(/tied to your session, not a share link/i)).toBeInTheDocument()
    expect(screen.queryByTitle(/tied to your session/i)).not.toBeInTheDocument()
  })

  it('points the open link at that warning for assistive technology', async () => {
    await expandRow()

    const note = await screen.findByText(/tied to your session/i)
    const noteId = note.closest('span[id]')?.getAttribute('id')
    expect(noteId).toBeTruthy()
    expect(screen.getByRole('link', { name: openLinkName })).toHaveAttribute('aria-describedby', noteId)
  })

  it('does not dangle aria-describedby when there is no readable deadline', async () => {
    // An unsigned URL renders no note, so the anchor must not reference a missing id.
    mockGetProject.mockResolvedValue({
      project_id: 'p1', documents: [prfaq, prototypeDoc(PROTOTYPE_PATH)],
    })

    await expandRow()

    expect(await screen.findByRole('link', { name: openLinkName }))
      .not.toHaveAttribute('aria-describedby')
    expect(screen.queryByText(/Link valid until/)).not.toBeInTheDocument()
  })

  it('reports a lapsed link instead of promising a window it cannot honour', async () => {
    mockGetProject.mockResolvedValue({
      project_id: 'p1', documents: [prfaq, prototypeDoc(signedUrl(Date.now() - HOUR_MS, 'sig-old'))],
    })

    await expandRow()

    expect(await screen.findByText(/Link expired/)).toBeInTheDocument()
    expect(screen.queryByText(/Link valid until/)).not.toBeInTheDocument()
  })
})
