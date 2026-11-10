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

const mockFetchApi = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>()
vi.mock('./client', () => ({ fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init) }))

import { votingSessionsApi } from './votingSessionsApi'
import { DEFAULT_AXES, activeAxes } from './prioritizationAxes'
import { at } from '@test/defined'

const SESSION_ID = 'vs_0123456789abcdef0123456789abcdef'

/** The parts of a `Response` this client reads. A stub, not a real `Response`,
 *  so a test whose code reads the body twice still sees it the second time. */
type StubResponse = Pick<Response, 'ok' | 'status' | 'json'>

function jsonResponse(body: unknown, status = 200): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<StubResponse>>()

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

describe("finding a row's open vote after a reload", () => {
  it('asks for the row by query string and returns its open session', async () => {
    mockFetchApi.mockResolvedValue({ session: { session_id: SESSION_ID, state: 'open', ballot_count: 2 } })

    const session = await votingSessionsApi.findOpenVotingSession('row_p1 default')

    expect(mockFetchApi).toHaveBeenCalledWith('/voting-sessions?row_id=row_p1+default', undefined)
    expect([session?.session_id, session?.ballot_count]).toStrictEqual([SESSION_ID, 2])
  })

  it.each([{ session: null }, { session: 'garbled' }, {}])('reads %o as no open vote', async (body) => {
    mockFetchApi.mockResolvedValue(body)

    expect(await votingSessionsApi.findOpenVotingSession('row_p1_default')).toBeNull()
  })
})

describe('what the ballot page is told before it renders a form', () => {
  it('reads an open session', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      session: { open: true, reason: null, row_title: 'Refunds' },
    }))

    const config = await votingSessionsApi.getBallotSessionConfig(SESSION_ID)

    // No `axes` (a deployment predating configurable metrics): the shipped default.
    expect(config).toStrictEqual({ open: true, reason: null, row_title: 'Refunds', axes: activeAxes(DEFAULT_AXES) })
  })

  it('reads the ACTIVE configured metrics the public config carries', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      session: {
        open: true, reason: null, row_title: 'Refunds',
        axes: [
          { id: 'reach', label: 'Reach', description: null, low_label: null, high_label: null, direction: 'higher_better', builtin: false },
          { id: 'effort', label: 'Effort', description: null, low_label: null, high_label: null, direction: 'lower_better', builtin: false },
        ],
      },
    }))

    const config = await votingSessionsApi.getBallotSessionConfig(SESSION_ID)

    expect(config.axes.map((axis) => [axis.id, axis.direction])).toStrictEqual([['reach', 'higher_better'], ['effort', 'lower_better']])
  })

  it('asks for it without a Content-Type, which a GET has no body to describe', async () => {
    // Setting one makes this a non-simple cross-origin request, so the browser
    // spends a preflight round trip on the first thing a phone does after scanning.
    fetchMock.mockResolvedValue(jsonResponse({ session: { open: true } }))

    await votingSessionsApi.getBallotSessionConfig(SESSION_ID)

    const [, init] = at(fetchMock.mock.calls, 0)
    expect(init?.headers).toBeUndefined()
  })

  it('says the proposal is gone when its row or project was deleted (410)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, reason: 'gone', error: 'deleted' }, 410))

    const config = await votingSessionsApi.getBallotSessionConfig(SESSION_ID)

    expect([config.open, config.reason]).toStrictEqual([false, 'gone'])
  })

  it.each([
    ['a non-2xx response', jsonResponse({ error: 'boom' }, 500)],
    ['a body this client cannot read', jsonResponse({ nothing: true })],
  ])('renders as a closed session with no reason: %s', async (_case, response) => {
    fetchMock.mockResolvedValue(response)

    const config = await votingSessionsApi.getBallotSessionConfig(SESSION_ID)

    expect(config).toStrictEqual({ open: false, reason: null, row_title: '', axes: activeAxes(DEFAULT_AXES) })
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

    expect(result).toStrictEqual({ ok: true, ballotId: 'abc' })
  })

  it.each(['closed', 'expired', 'cap_reached', 'not_found', 'invalid'] as const)(
    'reports the refusal reason the page has words for: %s', async (reason) => {
      // A RESULT rather than a throw: every one of these is something the room has
      // to be told in a sentence, and a thrown status code cannot be translated.
      fetchMock.mockResolvedValue(jsonResponse({ success: false, reason }, 409))

      const result = await votingSessionsApi.submitBallot(SESSION_ID, { impact: 4 })

      expect(result).toStrictEqual({ ok: false, failure: reason })
    })

  it.each([
    ['a refusal with no reason', jsonResponse({ success: false }, 500)],
    ['a reason this client does not know', jsonResponse({ reason: 'teapot' }, 418)],
    ['an accepted response with no ballot id', jsonResponse({ corrected: true })],
  ])('reports `unknown` rather than inventing a session state: %s', async (_case, response) => {
    fetchMock.mockResolvedValue(response)

    const result = await votingSessionsApi.submitBallot(SESSION_ID, { impact: 4 })

    expect(result).toStrictEqual({ ok: false, failure: 'unknown' })
  })

  it('survives a response that is not JSON at all', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 502, json: () => Promise.reject(new Error('not json')),
    })

    const result = await votingSessionsApi.submitBallot(SESSION_ID, { impact: 4 })

    expect(result).toStrictEqual({ ok: false, failure: 'unknown' })
  })
})
