/**
 * The feature-request client: lenient normalizers and the board transport.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, AuthError } from '../lib/errors'
import {
  boardTransport, createFeatureRequestsApi, normalizeRequestDetail, normalizeRequestList,
} from './featureRequestsApi'

vi.mock('../lib/trustedOrigins', () => ({ isTrustedOrigin: () => true }))
vi.mock('./baseUrl', () => ({ getBaseUrl: () => 'https://api.example.com/v1' }))
vi.mock('./client', () => ({
  fetchApi: vi.fn(),
  apiErrorFor: async (response: Response) => new ApiError(response.status, 'Only an admin can do that'),
}))

const REQUEST = {
  request_id: 'fr_1', title: 'SSO for Acme', description: 'SAML', status: 'planned',
  reporter_email: 'dana@example.com', reporter_name: 'Dana', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
  totals: { supporters: 2, customers: 2, committed_usd: 50000, at_risk_usd: 120000 },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('feature-request normalizers', () => {
  it('reads a list response with its viewer', () => {
    const result = normalizeRequestList({ requests: [REQUEST], viewer: { email: 'dana@example.com', name: 'Dana', is_admin: true, pool: 'app' } })
    expect(result.requests).toHaveLength(1)
    expect(result.viewer).toStrictEqual({ email: 'dana@example.com', name: 'Dana', is_admin: true, pool: 'app' })
  })

  it('drops a row without an id but keeps the others', () => {
    const result = normalizeRequestList({ requests: [{ title: 'no id' }, REQUEST], viewer: {} })
    expect(result.requests.map((request) => request.request_id)).toStrictEqual(['fr_1'])
  })

  it('never reads an unreadable viewer as an admin', () => {
    const result = normalizeRequestList({ requests: [], viewer: 'junk' })
    expect(result.viewer).toStrictEqual({ email: '', name: '', is_admin: false, pool: 'board' })
  })

  it('keeps any status key for its board to read, a missing one as new, and junk totals as zero', () => {
    const [request, bare] = normalizeRequestList({ requests: [
      { ...REQUEST, status: 'archived', totals: { supporters: '3', committed_usd: -5, at_risk_usd: null } },
      { ...REQUEST, request_id: 'fr_2', status: 7 },
    ] }).requests
    expect(request?.status).toBe('archived')
    expect(bare?.status).toBe('new')
    expect(request?.totals).toStrictEqual({ supporters: 3, customers: 0, committed_usd: 0, at_risk_usd: 0 })
  })

  it('reads an empty or non-object list body as no requests', () => {
    expect(normalizeRequestList(null).requests).toStrictEqual([])
  })

  it('reads supports, with an unknown impact as none and optional fields absent', () => {
    const detail = normalizeRequestDetail({
      request: REQUEST,
      supports: [{ support_id: 'sup_1', email: 'lee@example.com', name: 'Lee', customer: 'Example Air', impact: 'maybe', amount_usd: '25000', deal: '' }],
    })
    expect(detail.supports[0]).toMatchObject({ impact: 'none', amount_usd: 25000, is_reporter: false })
    expect(detail.supports[0]?.deal).toBeUndefined()
  })
})

describe('the board transport', () => {
  function stubFetch(...responses: Response[]) {
    const fetchMock = vi.fn<typeof fetch>()
    for (const response of responses) fetchMock.mockResolvedValueOnce(response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('sends the board token and parses the answer', async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ requests: [REQUEST], viewer: { pool: 'board' } })))
    const api = createFeatureRequestsApi(boardTransport(() => Promise.resolve('board-id-token')))

    const result = await api.listRequests()

    expect(result.requests).toHaveLength(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/feature-requests')
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('board-id-token')
  })

  it('refreshes once on 401 and retries with the new token', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 401 }), new Response(JSON.stringify({ requests: [], viewer: {} })))
    const getToken = vi.fn((force: boolean) => Promise.resolve(force ? 'fresh' : 'stale'))
    const api = createFeatureRequestsApi(boardTransport(getToken))

    await api.listRequests()

    expect(getToken.mock.calls).toStrictEqual([[false], [true]])
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('fresh')
  })

  it('reports a session that stays refused as an AuthError', async () => {
    stubFetch(new Response('{}', { status: 401 }), new Response('{}', { status: 401 }))
    const api = createFeatureRequestsApi(boardTransport(() => Promise.resolve(null)))
    await expect(api.listRequests()).rejects.toBeInstanceOf(AuthError)
  })

  it('reports a refusal with the status and the server reason', async () => {
    stubFetch(new Response(JSON.stringify({ success: false, message: 'Only an admin can do that' }), { status: 403 }))
    const api = createFeatureRequestsApi(boardTransport(() => Promise.resolve('t')))
    await expect(api.setStatus('fr_1', 'planned')).rejects.toMatchObject({ status: 403, message: 'Only an admin can do that' })
  })
})
