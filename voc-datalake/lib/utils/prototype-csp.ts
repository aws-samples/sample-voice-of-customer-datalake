/**
 * The Content-Security-Policy of a generated prototype (`/prototypes/*`).
 *
 * BASE is the egress control on model-authored inline JS: `default-src 'none'`
 * and no `connect-src`, so a prototype (a document holding PRD/PR-FAQ-derived
 * content) can make no outbound request. It is what every prototype gets.
 *
 * ONE exception, so the pin widget works when a prototype is opened on its own
 * (no SPA viewer to hand the pin to): a viewer-response CloudFront Function adds
 * `connect-src <url>` where <url> is the FULL path of the prototype's own
 * `POST /feedback-forms/<form_id>/submit` route — one URL, never an origin. It
 * does so only when ALL of these hold:
 *  - the S3 object carries `x-amz-meta-pin-submit-url` (user metadata only
 *    the document generator writes; model-authored HTML cannot set it);
 *  - that URL is an execute-api `…/<stage>/feedback-forms/pf_<16 hex>/submit`;
 *  - its form id is the one derived from the document id in the request path
 *    (`pf_` + sha256("prototype_pin|<doc_id>")[:16], the same derivation as
 *    lambda/shared/prototype_pins.py::pin_form_id).
 * Anything else (old prototypes, a copied prototype, an error response) gets
 * BASE. The metadata header itself is never sent to the viewer.
 *
 * The response-headers policy keeps BASE with `override: false`, so a response
 * the function does not run on (CloudFront skips viewer-response functions for
 * origin errors) still carries the strict policy.
 *
 * SANDBOX. Prototypes are served from the SAME CloudFront origin as the SPA,
 * whose Cognito tokens live in localStorage. Opened on its own, a prototype's
 * model-authored script would run on that origin and could read them. BASE
 * therefore carries `sandbox allow-scripts allow-popups` — never
 * `allow-same-origin` (that is the whole point: the document gets an OPAQUE
 * origin, so storage, cookies and same-origin DOM access to the SPA are gone),
 * never `allow-forms` or `allow-top-navigation` — plus `form-action 'none'`.
 * The in-app viewer frames it the same way (components/PrototypeRenderer.tsx)
 * and talks to it by postMessage, accepting `event.origin === 'null'`
 * (components/PrototypePins). A standalone pin submit therefore arrives with
 * `Origin: null`, which only the prototype-pin form's submit route accepts
 * (lambda/api/feedback_form_handler.py, docs/feedback-forms.md).
 */

/** The sandbox flags every prototype document gets: scripts and popups, nothing else. */
const PROTOTYPE_SANDBOX = 'sandbox allow-scripts allow-popups';

/** Every prototype's policy without the pin exception. */
export const PROTOTYPE_BASE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; " +
  "frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
  `${PROTOTYPE_SANDBOX};`;

/** S3 user-metadata key (sent by S3 as `x-amz-meta-<key>`), written by the document generator. */
export const PIN_SUBMIT_URL_METADATA_KEY = 'pin-submit-url';

/**
 * Source of the viewer-response function (cloudfront-js-2.0). Kept to ES5-style
 * syntax on purpose: it is not compiled, CloudFront runs this text. Exercised in
 * lib/utils/prototype-csp.test.ts by evaluating exactly this string.
 */
export function prototypeCspFunctionCode(): string {
  return `var crypto = require('crypto');
var BASE_CSP = ${JSON.stringify(PROTOTYPE_BASE_CSP)};
var META_HEADER = ${JSON.stringify(`x-amz-meta-${PIN_SUBMIT_URL_METADATA_KEY}`)};
var URI_RE = /^\\/prototypes\\/[A-Za-z0-9_-]+\\/([A-Za-z0-9_-]+)\\.html$/;
var SUBMIT_RE = /^https:\\/\\/[a-z0-9]{10}\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com(?:\\.cn)?\\/[A-Za-z0-9_-]+\\/feedback-forms\\/(pf_[0-9a-f]{16})\\/submit$/;

function pinFormId(documentId) {
  return 'pf_' + crypto.createHash('sha256').update('prototype_pin|' + documentId).digest('hex').slice(0, 16);
}

function allowedSubmitUrl(uri, value) {
  var doc = URI_RE.exec(uri || '');
  var submit = SUBMIT_RE.exec(value || '');
  if (!doc || !submit) return '';
  return submit[1] === pinFormId(doc[1]) ? value : '';
}

function handler(event) {
  var response = event.response;
  var headers = response.headers;
  var meta = headers[META_HEADER];
  delete headers[META_HEADER];
  var url = allowedSubmitUrl(event.request.uri, meta && meta.value);
  headers['content-security-policy'] = { value: url ? BASE_CSP + ' connect-src ' + url + ';' : BASE_CSP };
  return response;
}
`;
}
