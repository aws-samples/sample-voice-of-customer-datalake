/**
 * How long a prototype's CloudFront link is good for, and when to replace it.
 *
 * A prototype is served from `/prototypes/*`, a cache behavior restricted by a
 * trusted key group, so the browser needs a signed URL. The API mints one on
 * every `GET /projects/{id}` (`_with_signed_prototype_url`) and never trusts a
 * persisted value — the URL is therefore a session-scoped view credential with a
 * deadline, not a durable address. That is deliberate: the signer's TTL is
 * matched to the Cognito token lifetime so a link cannot outlive the session that
 * asked for it.
 *
 * Two things follow, and this module supplies the arithmetic for both:
 *
 * 1. The UI can state the deadline, because a canned-policy signature carries its
 *    own `Expires`. Reading it off the URL is the only honest source — the TTL is
 *    a Python-side fallback constant (`CDN_SIGNED_URL_TTL_SECONDS` is not set in
 *    the stack), so duplicating a number here would be a guess that silently
 *    diverges the day it is configured.
 *
 * 2. The app can replace the URL before it lapses. It has to happen *ahead* of
 *    expiry rather than in response to a failure: "Open in new tab" and
 *    "Download .html" are plain anchors, and a browser navigates the instant one
 *    is clicked — nothing can intervene to fetch a fresh signature first, and
 *    rewriting them as buttons that fetch then `window.open` would trade a 403
 *    for a popup blocker (`download` cannot be triggered that way at all).
 *
 * Pure and separate from the hook for the reason `jobsPollInterval` is: the
 * interesting cases are all about elapsed time, and driving a component through
 * them needs fake timers, which have leaked across files in this suite before.
 * It also returns no strings — the component owns the wording, which keeps every
 * i18n key statically visible to the extractor.
 */
import type { ProjectDocument } from '../api/types'

/**
 * How far before expiry to replace the URL.
 *
 * Generous relative to the cost (one request) and small relative to the ~1h
 * signature, so a click always lands on a link with minutes to spare rather than
 * seconds. It also has to comfortably exceed how long a refetch can take on a
 * slow connection, since the whole point is that the anchors are never stale.
 */
export const REFRESH_LEAD_MS = 5 * 60_000

/**
 * Floor on the scheduled delay.
 *
 * A URL that is already expired on arrival should be replaced promptly, but
 * "promptly" must not mean "immediately, forever": if the server ever returned
 * URLs that were expired the moment they were minted — a clock skew or a
 * misconfigured signer — a zero delay would spin refetches as fast as the network
 * allowed. The floor caps that pathological case at two requests a minute while
 * costing nothing in the normal one, where a just-minted URL has the better part
 * of an hour left and the delay is orders of magnitude above this.
 */
export const MIN_REFRESH_DELAY_MS = 30_000

/**
 * Epoch ms at which a signed CloudFront URL stops working, or null if that cannot
 * be determined.
 *
 * Null covers every "do not schedule anything, and do not claim a deadline" case:
 * no URL at all (legacy prototypes store their HTML inline and are rendered from
 * `content`), an unsigned URL, and a signature whose `Expires` is missing or not a
 * usable number. Callers must treat null as "say nothing" rather than substituting
 * a default, because a wrong deadline is worse than none.
 */
function readExpiresParam(url: string): string | null {
  try {
    return new URL(url).searchParams.get('Expires')
  } catch {
    // Not a parseable absolute URL. Nothing to report, and nothing to schedule.
    return null
  }
}

/**
 * Epoch ms at which a signed CloudFront URL stops working, or null if that cannot
 * be determined.
 *
 * Null covers every "do not schedule anything, and do not claim a deadline" case:
 * no URL at all (legacy prototypes store their HTML inline and are rendered from
 * `content`), an unsigned URL, and a signature whose `Expires` is missing or not a
 * usable number. Callers must treat null as "say nothing" rather than substituting
 * a default, because a wrong deadline is worse than none.
 */
export function signedUrlExpiresAt(url: string | undefined): number | null {
  if (url == null || url === '') return null
  const expiresRaw = readExpiresParam(url)
  if (expiresRaw == null || expiresRaw.trim() === '') return null
  // CloudFront's canned policy expresses Expires in SECONDS since the epoch.
  const seconds = Number(expiresRaw)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return seconds * 1000
}

/**
 * The part of a signed URL that identifies *which* document it points at, with the
 * credential stripped off.
 *
 * The whole difficulty with these URLs is that they fuse two things: an address
 * (origin + path, stable for the life of the document) and a credential (the
 * `Expires`/`Signature`/`Key-Pair-Id` query, replaced every time the project is
 * read). Consumers that must react to one but not the other — an iframe that
 * should reload for a different prototype but NOT for a re-signed same prototype —
 * need the address alone.
 *
 * Returns the raw string when it cannot be parsed, and undefined when there is
 * nothing to identify. An unparseable URL carries no working signature anyway, so
 * treating it as its own identity costs nothing.
 */
export function unsignedUrlKey(url: string | undefined): string | undefined {
  if (url == null || url === '') return undefined
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}

/**
 * The soonest moment any of this project's prototype links stops working, or null
 * if none of them has a readable deadline.
 *
 * The earliest wins because one refetch re-signs every prototype in the payload:
 * scheduling off the soonest deadline keeps all of them fresh, while scheduling
 * off the latest would let an earlier one lapse. In practice they are minted in
 * the same response and differ by milliseconds, so this matters only if that ever
 * stops being true.
 */
export function earliestPrototypeExpiry(
  documents: ReadonlyArray<Pick<ProjectDocument, 'document_type' | 'prototype_url'>>,
): number | null {
  return documents
    .filter((doc) => doc.document_type === 'prototype')
    .map((doc) => signedUrlExpiresAt(doc.prototype_url))
    // reduce rather than Math.min(...spread): same length, no argument-count
    // ceiling to think about if a project ever accumulates many prototypes.
    .reduce<number | null>(
      (soonest, expiry) => {
        if (expiry == null) return soonest
        return soonest == null ? expiry : Math.min(soonest, expiry)
      },
      null,
    )
}

/**
 * How long to wait before re-signing, or null to schedule nothing.
 *
 * Null means there is no deadline to beat — no prototype, or no readable
 * signature — and the caller must not set a timer, since a timer that fires
 * against nothing is a refetch loop with extra steps.
 */
export function refreshDelayMs(expiresAt: number | null, now: number): number | null {
  if (expiresAt == null) return null
  // ponytail: the floor wins whenever the deadline is nearer than the lead, so a
  // URL arriving with under REFRESH_LEAD_MS + MIN_REFRESH_DELAY_MS of life is
  // replaced on a fixed 30s cadence rather than proportionally — and one arriving
  // with under ~30s left is briefly dead before the replacement lands.
  //
  // Harmless at the deployed TTL (~1h, matched to the Cognito token lifetime) and
  // it keeps the pathological case bounded. But it sets a real ceiling: configure
  // CDN_SIGNED_URL_TTL_SECONDS below ~5.5 minutes and EVERY refresh is floored,
  // i.e. a refetch every 30s for as long as a prototype is on screen. If that TTL
  // ever becomes tunable in earnest, make the lead a fraction of the observed
  // lifetime (the URL knows it) instead of a constant.
  return Math.max(expiresAt - REFRESH_LEAD_MS - now, MIN_REFRESH_DELAY_MS)
}

/**
 * True once the link is past its deadline.
 *
 * Only reachable if the scheduled refresh could not run — a suspended machine, a
 * throttled background tab, or a refetch that failed — so it is a display concern
 * rather than a state to prevent: the label stops promising a window it cannot
 * honour, and the next focus refetch or timer fires replaces the URL.
 */
export function isExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt != null && expiresAt <= now
}
