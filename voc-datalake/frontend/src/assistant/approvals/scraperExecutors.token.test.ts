/**
 * An approved connector write goes out through the real API client with the
 * signed-in user's own Cognito token — no other credential, no other path.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

const { ENDPOINT, CONFIG } = vi.hoisted(() => ({
  ENDPOINT: 'https://api.example.com',
  CONFIG: {
    apiEndpoint: 'https://api.example.com',
    cognito: { userPoolId: 'pool-1', clientId: 'client-1', region: 'us-east-1' },
  },
}))

vi.mock('../../store/configStore', () => ({ useConfigStore: { getState: () => ({ config: { apiEndpoint: ENDPOINT }, dateBasis: 'imported' }) } }))
vi.mock('../../runtimeConfig', () => ({ isConfigLoaded: () => true, getRuntimeConfig: () => CONFIG }))
vi.mock('../../services/auth', () => ({
  authService: { isConfigured: () => true, getIdToken: () => 'user-id-token', refreshSession: vi.fn(), signOut: vi.fn() },
}))

import { getWriteTool } from './registry'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('create_scraper executes with the user token', () => {
  it('reads the list, then POSTs /scrapers with the user\u2019s Authorization header', async () => {
    fetchMock.mockResolvedValueOnce(json({ scrapers: [] })).mockResolvedValueOnce(json({ success: true }))
    const tool = getWriteTool('create_scraper')
    await tool?.execute(
      { id: 'acme', name: 'Acme', extraction_method: 'jsonld', base_url: 'https://www.acme.example/reviews' },
      { queryClient: new QueryClient() },
    )
    const calls = fetchMock.mock.calls.map(([url, init]) => [url instanceof Request ? url.url : String(url), init?.method ?? 'GET', new Headers(init?.headers).get('Authorization')])
    expect(calls).toStrictEqual([
      [`${ENDPOINT}/scrapers`, 'GET', 'user-id-token'],
      [`${ENDPOINT}/scrapers`, 'POST', 'user-id-token'],
    ])
  })
})
