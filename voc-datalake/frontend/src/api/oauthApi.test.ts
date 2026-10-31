/**
 * @fileoverview The MCP OAuth sign-in boundary (api/oauthApi.ts): each call hits its own route, every
 * response is parsed, and a redirect the consent page would follow is checked before it is returned
 * (the hosted UI, a loopback callback, or the request's own callback; anything else throws).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchApi = vi.hoisted(() => vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>())
const getHostedUiOrigin = vi.hoisted(() => vi.fn<() => string | null>())
vi.mock('./client', () => ({ fetchApi }))
vi.mock('../runtimeConfig', () => ({ getHostedUiOrigin }))

import { OAUTH_GRANTS_KEY, oauthApi, oauthConsentKey } from './oauthApi'
import type { ConsentChoice } from './oauthApi'
import { UntrustedOAuthRedirectError } from './oauthRedirect'

const HOSTED_UI = 'https://example-air.auth.us-east-1.amazoncognito.com'
const CALLBACK = 'https://assistant.example.com/callback'
const AUTHORIZE_QUERY = `client_id=kiro-client&state=abc&redirect_uri=${encodeURIComponent(CALLBACK)}`

const offer = (denyRedirect: string) => ({
  refused: false, client_kind: 'kiro', client_name: 'Kiro', can_write: true, can_run_agents: false,
  loopback: false, deny_redirect: denyRedirect,
})

const grant = {
  grant_id: 'g_1', client_kind: 'kiro', client_name: 'Kiro', scope: 'write', created_at: '2026-10-30T10:00:00Z',
  status: 'active', signed_in: true,
}

describe('oauthApi', () => {
  beforeEach(() => {
    fetchApi.mockReset()
    getHostedUiOrigin.mockReset()
    getHostedUiOrigin.mockReturnValue(HOSTED_UI)
  })

  it('keys the queries by the grants list and by the authorization query', () => {
    expect(OAUTH_GRANTS_KEY).toStrictEqual(['connect', 'oauth', 'grants'])
    expect(oauthConsentKey('a=1')).toStrictEqual(['connect', 'oauth', 'consent', 'a=1'])
  })

  describe('describeConsent', () => {
    it('sends the authorization query encoded and keeps a deny redirect to the request\'s own callback', async () => {
      fetchApi.mockResolvedValue(offer(`${CALLBACK}?error=access_denied&state=abc`))

      const consent = await oauthApi.describeConsent(AUTHORIZE_QUERY)

      expect(fetchApi).toHaveBeenCalledWith(`/connect/oauth/consent?authorize_query=${encodeURIComponent(AUTHORIZE_QUERY)}`)
      expect(consent).toMatchObject({ refused: false, deny_redirect: `${CALLBACK}?error=access_denied&state=abc` })
    })

    it('keeps a refused request\'s redirect to a loopback callback', async () => {
      const redirect = 'http://127.0.0.1:43123/callback?error=invalid_request'
      fetchApi.mockResolvedValue({ refused: true, error: 'invalid_request', error_description: 'bad', redirect_to: redirect })

      await expect(oauthApi.describeConsent(AUTHORIZE_QUERY)).resolves.toMatchObject({ refused: true, redirect_to: redirect })
    })

    it('throws when a refused request would send the browser somewhere else', async () => {
      fetchApi.mockResolvedValue({ refused: true, error: 'invalid_request', redirect_to: 'https://attacker.example.net/x' })

      await expect(oauthApi.describeConsent(AUTHORIZE_QUERY)).rejects.toBeInstanceOf(UntrustedOAuthRedirectError)
    })

    it('throws when the deny redirect is not the request\'s callback', async () => {
      fetchApi.mockResolvedValue(offer('https://assistant.example.com/other'))

      await expect(oauthApi.describeConsent(AUTHORIZE_QUERY)).rejects.toBeInstanceOf(UntrustedOAuthRedirectError)
    })

    it('throws on a malformed description', async () => {
      fetchApi.mockResolvedValue({ refused: false })

      await expect(oauthApi.describeConsent(AUTHORIZE_QUERY)).rejects.toThrow(/client_kind|invalid/i)
    })
  })

  describe('approveConsent', () => {
    const choice: ConsentChoice = { authorize_query: AUTHORIZE_QUERY, scope: 'read' }

    it('posts the choice and returns the hosted UI redirect', async () => {
      const redirect = `${HOSTED_UI}/oauth2/authorize?client_id=kiro-client`
      fetchApi.mockResolvedValue({ redirect_to: redirect })

      await expect(oauthApi.approveConsent(choice)).resolves.toBe(redirect)
      expect(fetchApi).toHaveBeenCalledWith('/connect/oauth/consent', { method: 'POST', body: JSON.stringify(choice) })
    })

    it('refuses a hosted UI redirect when the deployment names no hosted UI', async () => {
      getHostedUiOrigin.mockReturnValue(null)
      fetchApi.mockResolvedValue({ redirect_to: `${HOSTED_UI}/oauth2/authorize` })

      await expect(oauthApi.approveConsent(choice)).rejects.toBeInstanceOf(UntrustedOAuthRedirectError)
    })
  })

  describe('grants', () => {
    it('lists my sign-ins and drops a malformed row', async () => {
      fetchApi.mockResolvedValue({ grants: [grant, { client_name: 'no id' }] })

      const grants = await oauthApi.listGrants()

      expect(fetchApi).toHaveBeenCalledWith('/connect/oauth/grants')
      expect(grants.map((row) => row.grant_id)).toStrictEqual(['g_1'])
    })

    it('revokes one sign-in by its encoded id with DELETE', async () => {
      fetchApi.mockResolvedValue({ grant: { ...grant, grant_id: 'g/1', status: 'revoked' } })

      const revoked = await oauthApi.revokeGrant('g/1')

      expect(fetchApi).toHaveBeenCalledWith('/connect/oauth/grants/g%2F1', { method: 'DELETE' })
      expect(revoked).toMatchObject({ grant_id: 'g/1', status: 'revoked' })
    })
  })
})
