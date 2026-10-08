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
import i18n from 'i18next'
import {
  prioritizationMocks, projectsApiModule, clientApiModuleOverOriginal, configStoreModule, reactMarkdownModule, project,
} from './prioritization-fixtures'
import { openRow, renderUntilRow } from './prioritization-render-fixtures'

import type { VotingSession } from '../../api/votingSessionsApi'

const mockCreateVotingSession = vi.fn<(...args: unknown[]) => unknown>()
const mockGetVotingSession = vi.fn<(...args: unknown[]) => unknown>()
const mockCloseVotingSession = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/votingSessionsApi', () => ({
  votingSessionsApi: {
    createVotingSession: (input: unknown) => mockCreateVotingSession(input),
    getVotingSession: (id: string) => mockGetVotingSession(id),
    closeVotingSession: (id: string) => mockCloseVotingSession(id),
  },
}))

// The page harness for the one test that has to drive the whole table — see the
// PRD-row describe at the bottom.
vi.mock('../../api/projectsApi', () => projectsApiModule())
// The REAL module is spread and only `api` replaced. A factory that returns just
// `api` makes every other export of `client` disappear for this whole file —
// `fetchApi` among them, which `votingSessionsApi` imports — so a component
// anywhere in the Prioritization tree that reached for one would fail to resolve
// it, and being file-wide the mock would take the panel-only tests down with it.
vi.mock('../../api/client', async (importOriginal) => clientApiModuleOverOriginal(importOriginal))
vi.mock('../../store/configStore', () => configStoreModule())
vi.mock('react-markdown', () => reactMarkdownModule())

import RoomVotePanel from './RoomVotePanel'
import { ballotCountRefetchInterval } from './roomVotePolling'

const { t } = i18n
// A ROW id, not a document id: the session names the row, and every ballot's key
// derives from it server-side. The title is the row's — what the room reads.
const ROW_ID = 'row_p1_default'
/**
 * What these tests hand the panel as the row's title.
 *
 * A proposal's name rather than a document's, deliberately. The panel is rendered
 * DIRECTLY here and composes nothing: the title arrives as a prop, and the page decides
 * upstream that it is the leading document's. Naming it `'Feature A PR/FAQ'` made the
 * constant claim a type the row's leading document does not have in the page-level
 * describe below (where the row leads with `'Feature A PRD'`), which read as a fixture
 * disagreeing with itself. Which document a row leads with is that describe's subject,
 * and it says so with its own fixtures.
 */
const ROW_TITLE = 'Instant refunds'
/** How many documents the row holds; drives the "one ballot covers N" copy. */
const ROW_DOCUMENT_COUNT = 2

function session(overrides: Partial<VotingSession> = {}): VotingSession {
  return {
    session_id: 'vs_' + '1a'.repeat(16),
    row_id: ROW_ID,
    row_title: ROW_TITLE,
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
      <RoomVotePanel rowId={ROW_ID} rowTitle={ROW_TITLE} documentCount={ROW_DOCUMENT_COUNT} />
    </QueryClientProvider>,
  )
}

/** Open a session and wait for the panel to show it. */
async function openVote() {
  const user = userEvent.setup()
  renderPanel()
  await user.click(screen.getByRole('button', { name: t('prioritization:roomVote.open') }))
  await waitFor(() => {
    expect(mockCreateVotingSession).toHaveBeenCalledWith({ row_id: ROW_ID, row_title: ROW_TITLE })
  })
  return user
}

/** The QR, named for assistive technology — it carries no text of its own. */
const qr = () => screen.queryByRole('img', {
  name: t('prioritization:roomVote.qrAccessibleName', { title: ROW_TITLE }),
})

/** Both the open and the poll answer `record`. */
function givenTheSessionIs(record: VotingSession) {
  mockCreateVotingSession.mockResolvedValue(record)
  mockGetVotingSession.mockResolvedValue(record)
}

/**
 * A session that ran out its clock: `status` still reads `open` — and will until the
 * TTL sweeper gets to it — while `state` folds the deadline in.
 */
function givenAnExpiredSession() {
  givenTheSessionIs(session({ status: 'open', state: 'expired' }))
}

/** Open the vote and wait for the panel to say the session expired. */
async function expectExpiredAfterOpening() {
  await openVote()

  await waitFor(() => {
    expect(screen.getByText(t('prioritization:roomVote.expired'))).toBeInTheDocument()
  })
}

/** Open the row titled `title` and its room vote, then check the session was created on the ROW. */
async function expectVoteOpenedOnTheRow(title: string) {
  givenTheSessionIs(session())
  const user = await openRow(title)

  await user.click(await screen.findByRole('button', {
    name: t('prioritization:roomVote.open'),
  }))

  await waitFor(() => {
    expect(mockCreateVotingSession).toHaveBeenCalledWith({ row_id: ROW_ID, row_title: title })
  })
}

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
      row_id: ROW_ID, row_title: ROW_TITLE,
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
      t('prioritization:roomVote.scopeNote', { title: ROW_TITLE }),
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
    givenAnExpiredSession()

    await expectExpiredAfterOpening()
    expect(qr()).not.toBeInTheDocument()
  })

  it('offers a way back, so a second round needs no page reload', async () => {
    // A vote ends without the facilitator choosing to: it expires. With no exit
    // from the ended panel, asking the room again meant reloading the
    // prioritization page and losing the expanded row.
    givenAnExpiredSession()
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
    mockGetVotingSession.mockImplementation((id: unknown) => Promise.resolve(
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
    givenAnExpiredSession()

    await expectExpiredAfterOpening()
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

describe('a room vote opens on the ROW, covering every document it holds', () => {
  /**
   * The row's two documents, PR/FAQ older than PRD.
   *
   * `collectRows` orders a row's documents NEWEST FIRST and names the row after the
   * leading one, so this fixture makes the PRD the row's title — which is the case worth
   * defaulting to here, because a facilitator naming the session after "whichever
   * document happens to be newest" is the observable consequence of a row having no
   * title of its own. The reversed case has its own test below.
   */
  const prfaqOlder = {
    document_id: 'doc_prfaq', document_type: 'prfaq', title: 'Feature A PR/FAQ',
    content: '# Feature A', created_at: '2025-01-01',
  }
  const prdNewer = {
    document_id: 'doc_prd', document_type: 'prd', title: 'Feature A PRD',
    content: 'PRD content', created_at: '2025-01-02',
  }
  /** The project's one row, holding both of its scorable documents. */
  const row = {
    row_id: ROW_ID,
    project_id: 'p1',
    document_ids: ['doc_prd', 'doc_prfaq'],
    prototype_id: '',
    is_default: true,
    created_at: '2025-01-02',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    prioritizationMocks.getProjects.mockResolvedValue({ projects: [project] })
    prioritizationMocks.getProject.mockResolvedValue({ project_id: 'p1', documents: [prfaqOlder, prdNewer] })
    prioritizationMocks.getPrioritizationScores.mockResolvedValue({ scores: {}, rows: { [ROW_ID]: row } })
    prioritizationMocks.createPrioritizationRow.mockResolvedValue({ success: true, created: false, row })
    prioritizationMocks.getFeedbackForms.mockResolvedValue({ forms: [] })
  })

  it('a project whose PRD and PR/FAQ describe one idea offers ONE room vote', async () => {
    // The defect this change removes, at the facilitator's end: two rows meant two
    // QR codes for one proposal, and whichever the room scanned scored half the
    // idea. The row is named after its newest document — the PRD here — and there
    // is no second row to open a competing session on.
    const user = userEvent.setup()
    await renderUntilRow('Feature A PRD')
    expect(screen.queryByRole('button', {
      name: t('prioritization:roomVote.open'),
    })).not.toBeInTheDocument()

    await user.click(screen.getByText('Feature A PRD'))

    expect(await screen.findAllByRole('button', {
      name: t('prioritization:roomVote.open'),
    })).toHaveLength(1)
  })

  it('opens the session on the ROW id, so the room scores the whole proposal', async () => {
    // What the ballots are keyed to. Sending a document id here is how a room ends
    // up scoring one half of a proposal from their phones.
    await expectVoteOpenedOnTheRow('Feature A PRD')
  })

  it('tells the facilitator how many documents that one ballot covers', async () => {
    // The public page states plainly what is being scored, and so does this half:
    // "one ballot covers all N documents behind it" is what makes a room's single
    // vote on a two-document proposal legible rather than surprising.
    await openRow('Feature A PRD')

    expect(await screen.findByText(
      t('prioritization:roomVote.scopeDocuments', { documents: 2 }),
    )).toBeInTheDocument()
  })

  it('names the session after the row title when a PR/FAQ leads the row', async () => {
    // The other order, which the deleted `it.each` was the only cover for: the row's
    // title is its LEADING document's, so a project whose PR/FAQ is the newer of the two
    // opens a session named after the PR/FAQ. Same row id either way — that is the point,
    // and it is what makes the title cosmetic and the id load-bearing.
    prioritizationMocks.getProject.mockResolvedValue({
      project_id: 'p1',
      documents: [
        { ...prfaqOlder, created_at: '2025-01-03' },
        prdNewer,
      ],
    })

    await expectVoteOpenedOnTheRow('Feature A PR/FAQ')
  })
})
