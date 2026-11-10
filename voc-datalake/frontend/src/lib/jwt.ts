/**
 * @fileoverview Reading the claims of a Cognito JWT in the browser.
 *
 * Decoding only: the signature is NOT checked here (the API's authorizer does that). The SPA reads
 * claims to show who is signed in and to know when a token expires.
 *
 * @module lib/jwt
 */
import { isRecord } from './typeGuards'

/** The payload of `token` (base64url, UTF-8 JSON), or `{}` when it is not a readable JWT. */
export function jwtPayload(token: string): Record<string, unknown> {
  try {
    const base64 = (token.split('.').at(1) ?? '').replaceAll('-', '+').replaceAll('_', '/')
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** When `token` expires (epoch milliseconds), or 0 when it carries no numeric `exp`. */
export function jwtExpiresAt(token: string): number {
  const exp = jwtPayload(token)['exp']
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : 0
}
