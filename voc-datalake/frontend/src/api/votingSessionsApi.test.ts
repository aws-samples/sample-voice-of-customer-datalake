/**
 * The wire boundary for a room vote.
 *
 * Two of these five calls are made with NO credentials by a phone that has just
 * scanned a QR, against whatever version of the API happens to be deployed. So
 * nothing here trusts a declared type: every response is parsed leniently, and
 * what a bad response degrades TO is the behaviour under test.
 *
 * The direction matters in both cases and it is not the same direction:
 *
 *  * a session whose `state` cannot be read counts as CLOSED, because claiming a
 *    dead vote is live puts a QR in front of a room for nothing;
 *  * a submission that fails for a reason this client cannot read reports
 *    `unknown`, because "try again" is honest about a fault and "this vote is
 *    closed" would be a claim about the session that nothing supports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./baseUrl', () => ({ getBaseUrl: () => 'https://api.example.com' }))

const mockFetchApi = vi.fn()
vi.mock('./client', () => ({ fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init) }))

import { votingSessionsApi } from './votingSessionsApi'

const SESSION_ID = 'vs_0123456789abcdef0123456789abcdef'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reading a session as the facilitator', () => {
  it('carries the state the panel decides on', async () => {
    mockFetchApi.mockResolvedValue({
      session: {
        session_id: SESSION_ID, row_id: 'row_p1_default', row_title: 'Refunds',
        status: 'open', state: 'open', ballot_cap: 40, ballot_count: 3,
      },
    })

    const session = await votingSessionsApi.getVotingSession(SESSION_ID)

    expect(session.state).toBe('open')
    expect(session.ballot_count).toBe(3)
  })

  it('reads a session with no state as closed, not as open', async () => {
    // An older API, or a field that stopped being sent. The panel keys its QR on
    // this, so the unreadable case has to be the one where nothing is on screen.
    mockFetchApi.mockResolvedValue({
      session: { session_id: SESSION_ID, status: 'open' },
    })

    const session = await votingSessionsApi.getVotingSession(SESSION_ID)

    expect(session.state).toBe('closed')
  })

  it('encodes the session id into the path', async () => {
    mockFetchApi.mockResolvedValue({ session: {} })

    await votingSessionsApi.getVotingSession('vs_a/b')

    expect(mockFetchApi).toHaveBeenCalledWith('/voting-sessions/vs_a%2Fb', undefined)
  })
})

describe('what the ballot page is told before it renders a form', () => {
  it('reads an open session', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      session: { open: true, reason: null, row_title: 'Refunds' },
    }))

    const config = await votingSessionsApi.getBallotSessionConfig(SESSION_ID)

    expect(config).toEqual({ open: true, reason: null, row_title: 'Refunds' })
  })

  it('asks for it without a Content-Type, which a GET has no body to describe', async () => {
    // Setting one makes this a non-simple cross-origin request, so the browser
    // spends a preflight round trip on the first thing a phone does after scanning.
    fetchMock.mockResolvedValue(jsonResponse({ session: { open: true } }))

    await votingSessionsApi.getBallotSessionConfig(SESSION_ID)

    const [, init] = fetchMock.mock.calls[0]
    expect(init?.headers).toBeUndefined()
  })

  it.each([
    ['a non-2xx response', jsonResponse({ error: 'boom' }, 500)],
    ['a body this client cannot read', jsonResponse({ nothing: true })],
  ])('renders as a closed session with no reason: %s', async (_case, response) => {
    fetchMock.mockResolvedValue(response)

    const config = await votingSessionsApi.getBallotSessionConfig(SESSION_ID)

    expect(config).toEqual({ open: false, reason: null, row_title: '' })
  })

  it('normalises an absent reason to null rather than leaving it undefined', async () => {
    // The page switches on this value; two spellings of "no reason given" would
    // send the absent case down a different branch from the explicit one.
    fetchMock.mockResolvedValue(jsonResponse({ session: { open: false } }))

    const config = await votingSessionsApi.getBallotSessionConfig(SESSION_ID)

    expect(config.reason).toBeNull()
  })
})

describe('casting a ballot', () => {
  it('returns the id the device keeps for correcting its vote', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ballot_id: 'abc', corrected: false }))

    const result = await votingSessionsApi.submitBallot(SESSION_ID, { impact: 4 })

    expect(result).toEqual({ ok: true, ballotId: 'abc', corrected: false })
  })

  it.each(['closed', 'expired', 'cap_reached', 'not_found', 'invalid'] as const)(
    'reports the refusal reason the page has words for: %s', async (reason) => {
      // A RESULT rather than a throw: every one of these is something the room has
      // to be told in a sentence, and a thrown status code cannot be translated.
      fetchMock.mockResolvedValue(jsonResponse({ success: false, reason }, 409))

      const result = await votingSessionsApi.submitBallot(SESSION_ID, { impact: 4 })

      expect(result).toEqual({ ok: false, failure: reason })
    })

  it.each([
    ['a refusal with no reason', jsonResponse({ success: false }, 500)],
    ['a reason this client does not know', jsonResponse({ reason: 'teapot' }, 418)],
    ['an accepted response with no ballot id', jsonResponse({ corrected: true })],
  ])('reports `unknown` rather than inventing a session state: %s', async (_case, response) => {
    fetchMock.mockResolvedValue(response)

    const result = await votingSessionsApi.submitBallot(SESSION_ID, { impact: 4 })

    expect(result).toEqual({ ok: false, failure: 'unknown' })
  })

  it('survives a response that is not JSON at all', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 502, json: () => Promise.reject(new Error('not json')),
    } as unknown as Response)

    const result = await votingSessionsApi.submitBallot(SESSION_ID, { impact: 4 })

    expect(result).toEqual({ ok: false, failure: 'unknown' })
  })
})
