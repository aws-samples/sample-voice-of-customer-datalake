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
 * @module api/feedbackFormUrls
 */
import { stripTrailingSlashes } from './baseUrl'

/**
 * The hosted public page for one feedback form.
 *
 * @param apiEndpoint the configured API base, with or without a trailing slash.
 * @param formId the form's server-minted id.
 */
export function feedbackFormPublicUrl(apiEndpoint: string, formId: string): string {
  return `${stripTrailingSlashes(apiEndpoint)}/feedback-forms/${formId}/iframe`
}
