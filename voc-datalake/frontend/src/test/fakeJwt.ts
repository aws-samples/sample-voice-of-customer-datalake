/**
 * Unsigned JWTs for specs: the SPA only decodes tokens (the API checks signatures), so a
 * `header.payload.sig` string with base64url JSON is a faithful stand-in.
 */

const base64Url = (value: object): string =>
  btoa(JSON.stringify(value)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_')

/** A JWT carrying `claims` (ASCII values only: `btoa`; pass `exp` in epoch seconds to control expiry). */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `${base64Url({ alg: 'none' })}.${base64Url(claims)}.sig`
}
