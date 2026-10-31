/**
 * @fileoverview Where the MCP OAuth consent page may send the browser (docs/mcp.md → "OAuth sign-in").
 * The consent API answers the URL to follow (Approve: Cognito's sign-in; Deny or a refused request: the
 * assistant's callback), and the SPA checks it before leaving, so a wrong or tampered answer cannot turn
 * the page into an open redirect. Allowed, and nothing else:
 *
 * - the configured Cognito hosted UI (`cognito.hostedUiDomain` in config.json), https;
 * - an RFC 8252 loopback callback: `http://127.0.0.1|localhost|[::1]:<port>/…` (a desktop assistant);
 * - the exact https callback the assistant sent in its own request (`redirect_uri` of the authorization
 *   query the consent API validated for that client), same origin and path, any query.
 *
 * @module api/oauthRedirect
 */

/** What a redirect is checked against: the deployment's hosted UI and the request's own callback. */
export interface OAuthRedirectPolicy {
  /** `https://<host>` of the Cognito hosted UI, or null when the deployment's config names none. */
  readonly hostedUiOrigin: string | null
  /** The `redirect_uri` of the MCP client's authorization query, or null when it has none. */
  readonly clientRedirectUri: string | null
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

function parse(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && url.port !== ''
}

function isClientCallback(url: URL, clientRedirectUri: string | null): boolean {
  const callback = clientRedirectUri === null ? null : parse(clientRedirectUri)
  return callback !== null && url.protocol === 'https:' && callback.protocol === 'https:'
    && url.origin === callback.origin && url.pathname === callback.pathname
}

/** Whether the consent page may navigate to `value` under `policy`. */
export function isAllowedOAuthRedirect(value: string, policy: OAuthRedirectPolicy): boolean {
  const url = parse(value)
  // No URL, or one carrying credentials: refused.
  if (url?.username !== '' || url.password !== '') return false
  if (policy.hostedUiOrigin !== null && url.protocol === 'https:' && url.origin === policy.hostedUiOrigin) return true
  return isLoopback(url) || isClientCallback(url, policy.clientRedirectUri)
}

/** The `redirect_uri` an MCP client's authorization query carries, or null. */
export function clientRedirectUriOf(authorizeQuery: string): string | null {
  return new URLSearchParams(authorizeQuery).get('redirect_uri')
}

/** Thrown when the consent API's redirect is not one the page may follow (the page shows its error state). */
export class UntrustedOAuthRedirectError extends Error {
  constructor() {
    super('The sign-in redirect is not one this page may follow')
    this.name = 'UntrustedOAuthRedirectError'
  }
}

/** `value` when allowed under `policy`; throws {@link UntrustedOAuthRedirectError} otherwise. */
export function requireAllowedOAuthRedirect(value: string, policy: OAuthRedirectPolicy): string {
  if (!isAllowedOAuthRedirect(value, policy)) throw new UntrustedOAuthRedirectError()
  return value
}
