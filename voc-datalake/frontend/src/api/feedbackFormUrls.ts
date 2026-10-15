/**
 * @fileoverview The public address of a feedback form's hosted page.
 *
 * `GET /feedback-forms/{id}/iframe` returns a complete, mobile-ready HTML
 * document — a phone can open it directly — so it is the form's public page as
 * well as its embed target. Two features now point at it: the form's own card
 * offers it as a link, a copyable URL and an `<iframe>` snippet, and the QR shown
 * beside both renders the same address as scannable modules.
 *
 * One exported builder rather than a template literal per call site, for the same
 * reason `feedbackFormQueryKeys` exists: a second spelling drifts silently. A QR
 * is the worst possible place for that — nothing on screen reveals which address
 * was encoded, so a stale or malformed one is only discovered by a room full of
 * phones failing to load it.
 *
 * `iframe` is deliberately the route name: it is public, unauthenticated, and
 * already pasted into customers' embed snippets, so it cannot be renamed here.
 *
 * The endpoint is normalized with `baseUrl`'s own `stripTrailingSlashes` rather
 * than a local trim: it is user-entered configuration, `…amazonaws.com/v1/` is a
 * normal thing to paste, and every API request already goes through that
 * function — a QR that resolved differently from the requests would be a
 * difference nobody could see. (It costs no extra weight in any chunk: both
 * render sites already import `api/client`, which imports `baseUrl`.)
 *
 * Because that argument cuts both ways, the answer to an endpoint this cannot
 * build on is null rather than a best effort. `getBaseUrl` may fall back to the
 * relative '/api' — correct for a fetch the app itself issues — but a QR carrying
 * '/feedback-forms/{id}/iframe' is scanned by a phone with no idea what it is
 * relative to, and that failure looks exactly like success until a room full of
 * browsers opens nothing. The decision lives here, once, so neither render site
 * re-derives it.
 *
 * @module api/feedbackFormUrls
 */
import { stripTrailingSlashes } from './baseUrl'

/**
 * The API bases a public form address can be built on.
 *
 * The endpoint is user-entered configuration, and the string built from it goes
 * into an `<a href>`, an `<iframe src>` the customer pastes into their own page,
 * and a QR a phone opens. `javascript:` and `data:` bases parse as perfectly
 * valid URLs; they are not valid APIs, and not things to hand a browser.
 */
const ADDRESSABLE_PROTOCOLS = ['http:', 'https:']

/**
 * The endpoint as an absolute base to build on, or null if it is not one.
 *
 * Parsed rather than pattern-matched: `new URL` in a try/catch is already how
 * `prototypeLinkLifetime` asks this exact question, the URL grammar is the only
 * honest authority on it, and a hand-rolled expression would be both wrong at the
 * edges and a `sonarjs/slow-regex` finding.
 */
function addressableBase(apiEndpoint: string): string | null {
  const base = stripTrailingSlashes(apiEndpoint)
  try {
    return ADDRESSABLE_PROTOCOLS.includes(new URL(base).protocol) ? base : null
  } catch {
    // Not absolute. '' (nothing configured yet) and '/api' (the relative fetch
    // fallback) both land here, and neither addresses anything off-device.
    return null
  }
}

/**
 * The hosted public page for one feedback form, or null when the configured
 * endpoint cannot address it.
 *
 * Callers must render something other than a link or a QR for null — see
 * `FormQrCode`, which says so in words, because a QR cannot.
 *
 * @param apiEndpoint the configured API base, with or without a trailing slash.
 * @param formId the form's server-minted id.
 */
export function feedbackFormPublicUrl(apiEndpoint: string, formId: string): string | null {
  const base = addressableBase(apiEndpoint)
  if (base === null) return null
  // Encoded even though the id is minted server-side: it is now a path segment in
  // a snippet customers paste and in a QR nobody can read. An id carrying a slash
  // or a '?' would quietly address a different resource instead of failing.
  return `${base}/feedback-forms/${encodeURIComponent(formId)}/iframe`
}
