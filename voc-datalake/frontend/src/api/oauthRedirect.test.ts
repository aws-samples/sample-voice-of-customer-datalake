/**
 * @fileoverview The MCP OAuth consent page leaves the SPA only for the configured hosted UI, an RFC 8252
 * loopback callback, or the exact https callback the assistant's own request named (api/oauthRedirect.ts),
 * and oauthApi refuses any other redirect the consent API answers, so the page shows its error state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'
import { clientRedirectUriOf, isAllowedOAuthRedirect, UntrustedOAuthRedirectError } from './oauthRedirect'
import type { OAuthRedirectPolicy } from './oauthRedirect'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
const hostedUi = vi.hoisted(() => {
  const state: { origin: string | null } = { origin: null }
  return state
})
vi.mock('../runtimeConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtimeConfig')>(),
  getHostedUiOrigin: () => hostedUi.origin,
}))

const { oauthApi } = await import('./oauthApi')

const HOSTED = 'https://voc-example.auth.us-east-1.amazoncognito.com'
const WEB_CALLBACK = 'https://assistant.example.com/oauth/callback'
/** The same URL over http (built, so the refused cases name no clear-text URL literal). */
const overHttp = (url: string): string => url.replace(/^https:/, 'http:')
const POLICY: OAuthRedirectPolicy = { hostedUiOrigin: HOSTED, clientRedirectUri: WEB_CALLBACK }

describe('isAllowedOAuthRedirect', () => {
  it.each([
    `${HOSTED}/oauth2/authorize?client_id=c&state=s`,
    'http://127.0.0.1:53111/oauth/callback?error=access_denied',
    'http://localhost:8080/callback',
    'http://[::1]:4000/callback?code=x',
    'http://127.0.0.1:1024/oauth/callback',
    'http://127.0.0.1:65535/oauth/callback',
    `${WEB_CALLBACK}?error=access_denied&state=s`,
  ])('allows %s', (url) => {
    expect(isAllowedOAuthRedirect(url, POLICY)).toBe(true)
  })

  it.each([
    'https://evil.example.com',
    'https://evil.example.com/oauth2/authorize',
    overHttp(`${HOSTED}/oauth2/authorize`),
    'https://voc-example.auth.us-east-1.amazoncognito.com.evil.example.com/oauth2/authorize',
    'http://127.0.0.1/oauth/callback',
    // Outside 1024-65535, the server relay's range: a privileged port, one too low, one out of range.
    'http://127.0.0.1:80/oauth/callback',
    'http://localhost:1023/callback',
    'http://127.0.0.1:70000/oauth/callback',
    'https://127.0.0.1:53111/oauth/callback',
    overHttp('https://192.168.1.10:53111/callback'),
    'https://assistant.example.com/other',
    overHttp(WEB_CALLBACK),
    'https://user:pw@voc-example.auth.us-east-1.amazoncognito.com/oauth2/authorize',
    'javascript:alert(1)',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isAllowedOAuthRedirect(url, POLICY)).toBe(false)
  })

  it('refuses the hosted UI when the deployment names none, and a callback the request did not name', () => {
    const bare: OAuthRedirectPolicy = { hostedUiOrigin: null, clientRedirectUri: null }
    expect(isAllowedOAuthRedirect(`${HOSTED}/oauth2/authorize`, bare)).toBe(false)
    expect(isAllowedOAuthRedirect(WEB_CALLBACK, bare)).toBe(false)
    expect(isAllowedOAuthRedirect('http://127.0.0.1:53111/oauth/callback', bare)).toBe(true)
  })

  it('reads the callback from the authorization query', () => {
    expect(clientRedirectUriOf(`client_id=c&redirect_uri=${encodeURIComponent(WEB_CALLBACK)}`)).toBe(WEB_CALLBACK)
    expect(clientRedirectUriOf('client_id=c')).toBeNull()
  })
})

describe('oauthApi redirects', () => {
  const QUERY = `client_id=c&redirect_uri=${encodeURIComponent(WEB_CALLBACK)}`
  const CONSENT_GET = `GET /connect/oauth/consent?authorize_query=${encodeURIComponent(QUERY)}`
  const consent = (denyRedirect: string) => ({
    refused: false, client_kind: 'web', client_name: 'Web assistant', can_write: true, can_run_agents: false,
    loopback: false, deny_redirect: denyRedirect,
  })

  beforeEach(() => {
    resetFetchApi()
    hostedUi.origin = HOSTED
  })

  it('passes the hosted sign-in and the request\'s own callback through', async () => {
    route({
      [CONSENT_GET]: () => consent(`${WEB_CALLBACK}?error=access_denied`),
      'POST /connect/oauth/consent': () => ({ redirect_to: `${HOSTED}/oauth2/authorize?state=s` }),
    })
    await expect(oauthApi.describeConsent(QUERY)).resolves.toMatchObject({ deny_redirect: `${WEB_CALLBACK}?error=access_denied` })
    await expect(oauthApi.approveConsent({ authorize_query: QUERY, scope: 'read' })).resolves.toBe(`${HOSTED}/oauth2/authorize?state=s`)
    expect(fetchApi).toHaveBeenCalledTimes(2)
  })

  it('refuses https://evil.example.com as the approval, the deny and the refusal redirect', async () => {
    route({
      [CONSENT_GET]: () => consent('https://evil.example.com'),
      'POST /connect/oauth/consent': () => ({ redirect_to: 'https://evil.example.com' }),
    })
    await expect(oauthApi.describeConsent(QUERY)).rejects.toBeInstanceOf(UntrustedOAuthRedirectError)
    await expect(oauthApi.approveConsent({ authorize_query: QUERY, scope: 'write' })).rejects.toBeInstanceOf(UntrustedOAuthRedirectError)
    route({ [CONSENT_GET]: () => ({ refused: true, error: 'invalid_scope', error_description: '', redirect_to: 'https://evil.example.com/' }) })
    await expect(oauthApi.describeConsent(QUERY)).rejects.toBeInstanceOf(UntrustedOAuthRedirectError)
  })

  it('refuses the hosted sign-in when config.json names no hosted UI', async () => {
    hostedUi.origin = null
    route({ 'POST /connect/oauth/consent': () => ({ redirect_to: `${HOSTED}/oauth2/authorize` }) })
    await expect(oauthApi.approveConsent({ authorize_query: QUERY, scope: 'read' })).rejects.toBeInstanceOf(UntrustedOAuthRedirectError)
  })
})
