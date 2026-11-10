/**
 * @fileoverview The emailed sign-in link carries `?email=&code=`. Once read, those two must never
 * travel on: not to `/board` after sign-in (the used code would stay in history) and not back to
 * `/board/login` after sign-out (a stale link would read as "opened in a different browser").
 *
 * @module pages/Board/signInLink
 */

/** The query parameters only the emailed sign-in link sets. */
const SIGN_IN_PARAMS = ['email', 'code'] as const

/** `search` (`?…` or empty) without the sign-in link's `email` / `code`; other params are kept. */
export function withoutSignInParams(search: string): string {
  const params = new URLSearchParams(search)
  for (const name of SIGN_IN_PARAMS) params.delete(name)
  const rest = params.toString()
  return rest === '' ? '' : `?${rest}`
}

/** True when `search` still carries part of the sign-in link. */
export function hasSignInParams(search: string): boolean {
  const params = new URLSearchParams(search)
  return SIGN_IN_PARAMS.some((name) => params.has(name))
}
