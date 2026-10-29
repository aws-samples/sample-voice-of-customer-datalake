/**
 * @fileoverview A cheap client-side email shape check (one `@`, a dotted domain, no spaces).
 *
 * Its own dependency-free module: `api/boardFields.ts` used to import it from `services/boardAuth.ts`,
 * which imports `api/boardFields.ts` back. That import cycle made the production bundle read a binding
 * before it was initialised ("Cannot access 'LA' before initialization", 5.36.01 / 5.36.02: the whole
 * app stayed blank). The server's check is the real one.
 *
 * @module utils/looksLikeEmail
 */

export function looksLikeEmail(email: string): boolean {
  const [local = '', domain = '', ...rest] = email.split('@')
  const labels = domain.split('.')
  return rest.length === 0 && local !== '' && labels.length > 1 && labels.every((label) => label !== '') && !/\s/.test(email)
}
