/**
 * The facilitator's half of a room vote.
 *
 * The behaviour these exist for is the one a comment cannot hold: a session ends
 * in TWO ways, and only one of them is somebody pressing Close. A session that
 * runs out its clock is still stored as `status: 'open'` — DynamoDB's TTL sweeper
 * lags by up to about 48 hours — so a panel that reads `status` keeps a live-
 * looking QR on a projector and keeps polling, while every phone that scans it is
 * refused. `state` is the field that folds the deadline in, and these pin that the
 * panel reads it.
 *
 * Also pinned: the ballot count renders as numbers. It is interpolated with
 * `received` rather than `count`, because `count` is i18next's reserved option and
 * passing it makes the resolver look for plural forms that do not exist in eight
 * catalogues — the failure being a raw key path in front of a room.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import i18n from 'i18next'

import type { VotingSession } from '../../api/votingSessionsApi'

const mockCreateVotingSession = vi.fn()
const mockGetVotingSession = vi.fn()
const mockCloseVotingSession = vi.fn()

vi.mock('../../api/votingSessionsApi', () => ({
  votingSessionsApi: {
    createVotingSession: (input: unknown) => mockCreateVotingSession(input),
    getVotingSession: (id: string) => mockGetVotingSession(id),
    closeVotingSession: (id: string) => mockCloseVotingSession(id),
  },
}))

// The page harness for the one test that has to drive the whole table — see the
// PRD-row describe at the bottom.
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
// The REAL module is spread and only `api` replaced. A factory that returns just
// `api` makes every other export of `client` disappear for this whole file —
// `fetchApi` among them, which `votingSessionsApi` imports — so a component
// anywhere in the Prioritization tree that reached for one would fail to resolve
// it, and being file-wide the mock would take the panel-only tests down with it.
vi.mock('../../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/client')>(),
  api: {
    getPrioritizationScores: () => mockGetPrioritizationScores(),
    patchPrioritizationScores: () => Promise.resolve({ success: true }),
    getFeedbackForms: () => mockGetFeedbackForms(),
    getFeedbackFormStats: () => Promise.resolve({ success: true, stats: {} }),
  },
}))
vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com' } }),
}))
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))

import RoomVotePanel from './RoomVotePanel'
import { ballotCountRefetchInterval } from './roomVotePolling'
import Prioritization from './Prioritization'

const { t } = i18n
const DOCUMENT_ID = 'doc_prfaq'
const DOCUMENT_TITLE = 'Feature A PR/FAQ'

function session(overrides: Partial<VotingSession> = {}): VotingSession {
  return {
    session_id: 'vs_' + '1a'.repeat(16),
    document_id: DOCUMENT_ID,
    document_title: DOCUMENT_TITLE,
    status: 'open',
    state: 'open',
    ballot_cap: 40,
    ballot_count: 0,
    ...overrides,
  }
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <RoomVotePanel documentId={DOCUMENT_ID} documentTitle={DOCUMENT_TITLE} />
    </QueryClientProvider>,
  )
}

/** Open a session and wait for the panel to show it. */
async function openVote() {
  const user = userEvent.setup()
  renderPanel()
  await user.click(screen.getByRole('button', { name: t('prioritization:roomVote.open') }))
  await waitFor(() => {
    expect(mockCreateVotingSession).toHaveBeenCalled()
  })
  return user
}

/** The QR, named for assistive technology — it carries no text of its own. */
const qr = () => screen.queryByRole('img', {
  name: t('prioritization:roomVote.qrAccessibleName', { title: DOCUMENT_TITLE }),
})

/**
 * The QR is built on the LIVE origin — the ballot page is a route of this SPA —
 * and this suite shares one jsdom across every test file, where a stray
 * `window.location` replacement in an earlier file leaves `origin` undefined and
 * the panel correctly refuses to draw a QR it cannot address. Pinned here so these
 * tests state the origin they mean instead of inheriting one.
 */
function withKnownOrigin() {
  const original = window.location

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: new URL('https://app.example.com/prioritization'), writable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', { value: original, writable: true })
  })
}

describe('a room vote a facilitator opens', () => {
  withKnownOrigin()

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateVotingSession.mockResolvedValue(session())
    mockGetVotingSession.mockResolvedValue(session())
    mockCloseVotingSession.mockResolvedValue(session({ status: 'closed', state: 'closed' }))
  })

  it('puts a QR for THIS document on screen', async () => {
    await openVote()

    await waitFor(() => {
      expect(qr()).toBeInTheDocument()
    })
    expect(mockCreateVotingSession).toHaveBeenCalledWith({
      document_id: DOCUMENT_ID, document_title: DOCUMENT_TITLE,
    })
  })

  it('shows the ballot count and the cap as numbers', async () => {
    mockCreateVotingSession.mockResolvedValue(session({ ballot_count: 12, ballot_cap: 40 }))
    mockGetVotingSession.mockResolvedValue(session({ ballot_count: 12, ballot_cap: 40 }))

    await openVote()

    // Both numbers, and neither a raw key nor an uninterpolated placeholder —
    // which is what a reserved-option collision leaves on screen.
    const status = await screen.findByText(/12/)
    expect(status).toHaveTextContent('40')
    expect(status.textContent).not.toContain('{{')
    expect(status.textContent).not.toContain('roomVote.')
  })

  it('names the one document the session scores', async () => {
    renderPanel()

    expect(screen.getByText(
      t('prioritization:roomVote.scopeNote', { title: DOCUMENT_TITLE }),
    )).toBeInTheDocument()
  })
})

describe('a room vote that has ended', () => {
  withKnownOrigin()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('takes the QR down when the facilitator closes it', async () => {
    mockCreateVotingSession.mockResolvedValue(session())
    mockGetVotingSession.mockResolvedValue(session())
    mockCloseVotingSession.mockResolvedValue(session({ status: 'closed', state: 'closed' }))
    const user = await openVote()
    await waitFor(() => {
      expect(qr()).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: t('prioritization:roomVote.close') }))

    await waitFor(() => {
      expect(qr()).not.toBeInTheDocument()
    })
    expect(screen.getByText(t('prioritization:roomVote.closed'))).toBeInTheDocument()
  })

  it('takes the QR down when the session EXPIRED, which still reads as open', async () => {
    // The blocker: `status` is `open` on this record and always will be until the
    // TTL sweeper gets to it. A panel keyed on `status` leaves the QR up and sends
    // a room to a page that refuses all of them.
    const expired = session({ status: 'open', state: 'expired' })
    mockCreateVotingSession.mockResolvedValue(expired)
    mockGetVotingSession.mockResolvedValue(expired)

    await openVote()

    await waitFor(() => {
      expect(screen.getByText(t('prioritization:roomVote.expired'))).toBeInTheDocument()
    })
    expect(qr()).not.toBeInTheDocument()
  })

  it('offers a way back, so a second round needs no page reload', async () => {
    // A vote ends without the facilitator choosing to: it expires. With no exit
    // from the ended panel, asking the room again meant reloading the
    // prioritization page and losing the expanded row.
    const expired = session({ status: 'open', state: 'expired' })
    mockCreateVotingSession.mockResolvedValue(expired)
    mockGetVotingSession.mockResolvedValue(expired)
    const user = await openVote()
    await screen.findByText(t('prioritization:roomVote.expired'))

    await user.click(screen.getByRole('button', { name: t('prioritization:roomVote.openAnother') }))

    expect(screen.getByRole('button', { name: t('prioritization:roomVote.open') })).toBeInTheDocument()
    expect(screen.queryByText(t('prioritization:roomVote.expired'))).not.toBeInTheDocument()
  })

  it('opens the second vote cleanly instead of inheriting the first one', async () => {
    // The trap in the reset: `closeMutation.data` deliberately overrides the poll,
    // and `openMutation.data` seeds it as `initialData`, so leaving either behind
    // would make a freshly opened session render as the previous ended one.
    //
    // The second open returns a DIFFERENT session id, because a real one does. With
    // the same id the second render is served partly from the first session's query
    // cache — the safer path, and therefore the weaker test: it would pass for a
    // reset that left `closeMutation.data` in place on a genuinely fresh key.
    const second = session({ session_id: 'vs_' + '2b'.repeat(16) })
    mockCreateVotingSession
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(second)
    mockGetVotingSession.mockImplementation((id: string) => Promise.resolve(
      id === second.session_id ? second : session(),
    ))
    mockCloseVotingSession.mockResolvedValue(session({ status: 'closed', state: 'closed' }))
    const user = await openVote()
    await user.click(screen.getByRole('button', { name: t('prioritization:roomVote.close') }))
    await screen.findByText(t('prioritization:roomVote.closed'))
    await user.click(screen.getByRole('button', { name: t('prioritization:roomVote.openAnother') }))

    await user.click(screen.getByRole('button', { name: t('prioritization:roomVote.open') }))

    await waitFor(() => {
      expect(qr()).toBeInTheDocument()
    })
    expect(screen.queryByText(t('prioritization:roomVote.closed'))).not.toBeInTheDocument()
    // ...and it is the SECOND session on screen, not a cached view of the first.
    expect(mockGetVotingSession).toHaveBeenCalledWith(second.session_id)
  })

  it('says it expired rather than blaming the facilitator', async () => {
    const expired = session({ status: 'open', state: 'expired' })
    mockCreateVotingSession.mockResolvedValue(expired)
    mockGetVotingSession.mockResolvedValue(expired)

    await openVote()

    await waitFor(() => {
      expect(screen.getByText(t('prioritization:roomVote.expired'))).toBeInTheDocument()
    })
    expect(screen.queryByText(t('prioritization:roomVote.closed'))).not.toBeInTheDocument()
  })
})

describe('when the ballot count is read again', () => {
  /**
   * The DECISION, not the scheduler. Driving this through the component means
   * asserting on TanStack's timers, and fake timers installed after a query has
   * mounted observe nothing — a "polling stopped" test built that way passes for
   * an implementation that never stops, which is the bug being fixed. Known limit,
   * stated plainly: this covers the rule and not the one adjacent line that hands
   * it to `refetchInterval`.
   */
  it('keeps reading a session that is still taking ballots', () => {
    expect(ballotCountRefetchInterval(session({ state: 'open' }))).toBe(5000)
  })

  it.each(['closed', 'expired'] as const)('stops for a %s session', (state) => {
    // `expired` is the case that never stopped: the record still says
    // `status: 'open'`, so a poll keyed on `status` ran until the tab was shut.
    expect(ballotCountRefetchInterval(session({ status: 'open', state }))).toBe(false)
  })

  it('does not read a session it has not seen yet', () => {
    expect(ballotCountRefetchInterval(undefined)).toBe(false)
  })
})

describe('which rows can open a room vote', () => {
  const project = {
    project_id: 'p1', name: 'Project 1', status: 'active',
    created_at: '2025-01-01', updated_at: '2025-01-01', persona_count: 0, document_count: 2,
  }
  const prfaq = {
    document_id: 'doc_prfaq', document_type: 'prfaq', title: DOCUMENT_TITLE,
    content: '# Feature A', created_at: '2025-01-01',
  }
  const prd = {
    document_id: 'doc_prd', document_type: 'prd', title: 'Feature A PRD',
    content: 'PRD content', created_at: '2025-01-02',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProjects.mockResolvedValue({ projects: [project] })
    mockGetProject.mockResolvedValue({ project_id: 'p1', documents: [prfaq, prd] })
    mockGetPrioritizationScores.mockResolvedValue({ scores: {} })
    mockGetFeedbackForms.mockResolvedValue({ forms: [] })
  })

  it.each([DOCUMENT_TITLE, 'Feature A PRD'])('every scorable row can: %s', async (title) => {
    // Ballots are keyed by document id alone, so a row that cannot open a session
    // is a document the room simply cannot score. Both scorable document types —
    // PRD and PR/FAQ — render through PRFAQRow, and this is what says so.
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={createMemoryRouter([{ path: '/', element: <Prioritization /> }])} />
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText(title)).toBeInTheDocument()
    })

    await user.click(screen.getByText(title))

    expect(await screen.findByRole('button', {
      name: t('prioritization:roomVote.open'),
    })).toBeInTheDocument()
  })
})
