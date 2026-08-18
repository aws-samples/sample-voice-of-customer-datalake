/**
 * The anonymous ballot page — what a phone shows after scanning the QR.
 *
 * These are about WORDS, because on this page the words are the feature: the
 * submitter has no account, no history and nobody to ask. Every state has to be
 * said in a sentence that is true of it.
 *
 * Three that were not:
 *  * a permanent refusal (a ballot the API cannot read) was rendered as "try again
 *    in a moment", which is advice that can never work;
 *  * a refusal of THIS BALLOT was headed "this vote is not open", a false claim
 *    about a session that is open and running;
 *  * a failed CONFIG read was headed the same way, telling a room their vote was
 *    over because a fetch failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import i18n from 'i18next'

import type { BallotSessionConfig, BallotSubmission } from '../../api/votingSessionsApi'

const mockGetBallotSessionConfig = vi.fn()
const mockSubmitBallot = vi.fn()

vi.mock('../../api/votingSessionsApi', () => ({
  votingSessionsApi: {
    getBallotSessionConfig: (id: string) => mockGetBallotSessionConfig(id),
    submitBallot: (id: string, ballot: unknown) => mockSubmitBallot(id, ballot),
  },
}))

import Vote from './Vote'

const { t } = i18n
const SESSION_ID = 'vs_0123456789abcdef0123456789abcdef'
const OPEN: BallotSessionConfig = { open: true, reason: null, document_title: 'Instant refunds' }

function renderVotePage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/vote/:sessionId', element: <Vote /> }],
    { initialEntries: [`/vote/${SESSION_ID}`] },
  )
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const key = (name: string) => t(`prioritization:${name}`)

/** Fill nothing and press Submit — every slider already has a position the
 *  submitter can see, and the page sends all four. */
async function submit() {
  const user = userEvent.setup()
  renderVotePage()
  const button = await screen.findByRole('button', { name: key('ballot.submit.label') })
  await user.click(button)
  await waitFor(() => {
    expect(mockSubmitBallot).toHaveBeenCalled()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // `localStorage` is a non-persisting mock in this suite's setup, so it is driven
  // explicitly. Reset to "nothing stored" HERE and not only where a test needs a
  // value: `clearAllMocks` clears calls but leaves implementations in place, so a
  // return value set in one test would otherwise be a device that has already
  // voted in every test after it.
  vi.mocked(window.localStorage.getItem).mockReturnValue(null)
  mockGetBallotSessionConfig.mockResolvedValue(OPEN)
  mockSubmitBallot.mockResolvedValue({ ok: true, ballotId: 'abc', corrected: false })
})

describe('an open vote', () => {
  it('names the proposal and says the ballot is not attributed to anybody', async () => {
    renderVotePage()

    expect(await screen.findByText('Instant refunds')).toBeInTheDocument()
    expect(screen.getByText(key('ballot.anonymousNotice'))).toBeInTheDocument()
  })

  it('sends every axis, because every slider has a position the submitter saw', async () => {
    await submit()

    expect(mockSubmitBallot).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({
      impact: 3, time_to_market: 3, confidence: 3, strategic_fit: 3,
    }))
  })

  it('confirms the ballot was recorded', async () => {
    await submit()

    expect(await screen.findByText(key('ballot.done.title'))).toBeInTheDocument()
  })

  it('remembers this device\'s ballot, scoped to this session', async () => {
    await submit()
    // Waiting for the CONFIRMATION, not just for the call: the id is stored in the
    // mutation's success handler, so asserting before it has run would race it.
    expect(await screen.findByText(key('ballot.done.title'))).toBeInTheDocument()

    // The key carries the session id, so two votes in one meeting cannot hand each
    // other a ballot id — which the API would reject as belonging to another
    // session anyway, at the cost of a slot of the cap.
    expect(window.localStorage.setItem).toHaveBeenCalledWith(`voc-ballot-${SESSION_ID}`, 'abc')
  })

  it('sends a remembered id back, which is what makes the next one a correction', async () => {
    // This is what makes "one device, one ballot" true without cookies, accounts or
    // fingerprinting a stranger's phone.
    vi.mocked(window.localStorage.getItem).mockReturnValue('abc')

    await submit()

    expect(mockSubmitBallot).toHaveBeenCalledWith(
      SESSION_ID, expect.objectContaining({ ballot_id: 'abc' }),
    )
  })

  it('still casts the ballot when storage is unavailable', async () => {
    // Private browsing. The correction affordance is lost; the vote is not, and
    // nobody is shown an error about it.
    vi.mocked(window.localStorage.getItem).mockImplementation(() => {
      throw new Error('storage denied')
    })

    await submit()

    expect(await screen.findByText(key('ballot.done.title'))).toBeInTheDocument()
  })
})

describe('a refusal of THIS BALLOT', () => {
  it.each([
    ['invalid', 'ballot.closed.invalid'],
    ['unknown', 'ballot.closed.unknown'],
  ] as const)('is not headed as a closed vote: %s', async (failure, sentence) => {
    const refusal: BallotSubmission = { ok: false, failure }
    mockSubmitBallot.mockResolvedValue(refusal)

    await submit()

    expect(await screen.findByText(key(sentence))).toBeInTheDocument()
    expect(screen.getByText(key('ballot.rejected.title'))).toBeInTheDocument()
    expect(screen.queryByText(key('ballot.closed.title'))).not.toBeInTheDocument()
  })

  it('tells a permanent failure apart from a transient one', async () => {
    // The whole point of `invalid` having a reason of its own: "try again in a
    // moment" is what this state must NOT say.
    mockSubmitBallot.mockResolvedValue({ ok: false, failure: 'invalid' })

    await submit()

    expect(await screen.findByText(key('ballot.closed.invalid'))).toBeInTheDocument()
    expect(screen.queryByText(key('ballot.closed.unknown'))).not.toBeInTheDocument()
  })
})

describe('a vote that will not take a ballot', () => {
  it.each([
    ['closed', 'ballot.closed.closed'],
    ['expired', 'ballot.closed.expired'],
    ['cap_reached', 'ballot.closed.capReached'],
    ['not_found', 'ballot.closed.notFound'],
  ] as const)('says which state it is in, and shows no form: %s', async (reason, sentence) => {
    mockGetBallotSessionConfig.mockResolvedValue({ open: false, reason, document_title: '' })

    renderVotePage()

    expect(await screen.findByText(key(sentence))).toBeInTheDocument()
    expect(screen.getByText(key('ballot.closed.title'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: key('ballot.submit.label') })).not.toBeInTheDocument()
  })

  it('refuses mid-meeting without losing the reason', async () => {
    // The ordinary case in a room: the page loaded while the vote was open and the
    // facilitator closed it before Submit.
    mockSubmitBallot.mockResolvedValue({ ok: false, failure: 'closed' })

    await submit()

    expect(await screen.findByText(key('ballot.closed.closed'))).toBeInTheDocument()
  })
})

describe('a vote that could not be loaded', () => {
  it('does not tell a room their vote is over because a fetch failed', async () => {
    mockGetBallotSessionConfig.mockRejectedValue(new Error('network'))

    renderVotePage()

    expect(await screen.findByText(key('ballot.unavailable.title'))).toBeInTheDocument()
    expect(screen.getByText(key('ballot.unavailable.description'))).toBeInTheDocument()
    expect(screen.queryByText(key('ballot.closed.title'))).not.toBeInTheDocument()
    // Nor does it claim to have refused a ballot nobody submitted.
    expect(screen.queryByText(key('ballot.rejected.title'))).not.toBeInTheDocument()
  })
})
