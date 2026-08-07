/**
 * @fileoverview What happens when a session ends unexpectedly, in one place.
 *
 * Before this module the three callers agreed on nothing: `fetchApi` signed
 * out and hard-navigated to `/login` with no reason attached, `streamChat`
 * threw an inline "session expired" string and left the app rendering as if
 * signed in, and nothing revalidated a persisted session on boot. The
 * user-visible result was an expired token rendering a working, logged-in
 * application (round-2 UI review, U3).
 *
 * The reason rides in the URL rather than in storage deliberately. The
 * redirect is a full document load — the only reliable way to drop every
 * in-memory cache and in-flight request at once — so an in-memory signal
 * would not survive it, and `sessionStorage` is unavailable in some privacy
 * modes. A spoofed flag only shows a message, so it needs no integrity.
 *
 * @module services/sessionExpiry
 */
import { authService } from './auth'

/** Query flag appended to `/login` when a session ended unexpectedly. */
const EXPIRED_FLAG = 'expired'

/** Where an expired session lands, reason included. */
export const SESSION_EXPIRED_PATH = `/login?${EXPIRED_FLAG}=1`

/**
 * Whether a redirect is already under way.
 *
 * Concurrent requests 401 together, so all three callers can reach this within
 * the same tick. `location.replace` does not stop JavaScript from running, so
 * without this the second and third calls issue redundant navigations while
 * the first is still resolving. Module-level rather than per-call because the
 * callers are independent and never see each other.
 */
const ending = { inProgress: false }

/**
 * Clear auth state and send the user to `/login` with an explanation.
 *
 * `replace` rather than `assign`: the page we are leaving can no longer load
 * its data, so leaving it in the back history invites the user straight back
 * into the state this function exists to end.
 *
 * Idempotent — safe to call from every path that discovers the dead session.
 */
export function endExpiredSession(): void {
  if (ending.inProgress) return
  ending.inProgress = true
  authService.signOut()
  window.location.replace(SESSION_EXPIRED_PATH)
}

/**
 * Test seam: forget that a redirect happened.
 *
 * Production never needs this — the redirect is a full document load, which
 * resets the module. A test environment has no such reset, so without it the
 * first case to end a session would silently disarm every later one.
 */
export function resetSessionExpiryForTests(): void {
  ending.inProgress = false
}

/**
 * Whether this `/login` visit was caused by an expired session.
 *
 * Reads the flag without consuming it, so the notice survives re-renders
 * (typing in the form) and disappears only on navigation away.
 *
 * @param search - `location.search`, including the leading `?`
 */
export function isSessionExpiredRedirect(search: string): boolean {
  return new URLSearchParams(search).get(EXPIRED_FLAG) === '1'
}
