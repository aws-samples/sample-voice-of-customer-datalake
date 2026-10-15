/**
 * @fileoverview The public address of a voting session's ballot page.
 *
 * ONE builder, for the same reason `feedbackFormUrls` is one: a QR is the worst
 * possible place for two spellings of an address to drift, because nothing on
 * screen reveals which one was encoded. A stale or malformed URL is discovered by
 * a room full of phones opening nothing.
 *
 * It is built on the CURRENT ORIGIN, not on the configured API endpoint — the
 * ballot page is a route of this SPA (`/vote/:sessionId`), served by the same
 * CloudFront distribution the facilitator is looking at. The feedback form's QR
 * points at an API-served `/iframe` page instead because that page is embedded on
 * customers' own sites; a ballot page is ours, is only ever opened directly, and
 * belongs in the app where its copy lives in the same eight locale catalogues as
 * the rest.
 *
 * `location.origin` rather than a relative path: a QR is decoded by a phone with
 * no idea what it would be relative to. And rather than the API endpoint, which
 * is a different host — the app is at `d111.cloudfront.net`, the API at
 * `…execute-api…/v1`, and `/vote/x` on the second is a 403.
 *
 * @module api/ballotPageUrl
 */

/** The path a phone lands on. Must match the route in `routes.tsx`; a test pins
 *  the pair, because a rename on one side alone produces a QR that scans
 *  perfectly and shows the SPA's not-found state. */
export const BALLOT_PAGE_PATH_PREFIX = '/vote/'

/**
 * The address of one session's ballot page, or null when it cannot be built.
 *
 * Null for an origin no phone can reach — `about:blank` and a `file://` page both
 * produce `'null'` for `location.origin` — because a QR cannot report its own
 * failure and callers must say so in words instead (`SessionQrCode` does).
 *
 * @param origin normally `window.location.origin`, passed in so this is testable
 *   and so the caller decides where the app is being viewed from.
 * @param sessionId the server-minted session token; it is the whole of what makes
 *   the ballot route usable, and the only thing the QR carries.
 */
export function ballotPageUrl(origin: string, sessionId: string): string | null {
  if (!sessionId) return null
  try {
    const base = new URL(origin)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null
    // Encoded although the id is server-minted: it goes into a URL a phone
    // opens, and an id carrying a '?' or a '/' would address something else.
    return `${base.origin}${BALLOT_PAGE_PATH_PREFIX}${encodeURIComponent(sessionId)}`
  } catch {
    // Not an absolute origin — '' and 'null' both land here.
    return null
  }
}
