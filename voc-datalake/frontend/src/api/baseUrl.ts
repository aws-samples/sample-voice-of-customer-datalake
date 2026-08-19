/**
 * Shared URL utilities used by API clients (client.ts, streamClient.ts).
 */
import { authService } from '../services/auth'
import { useConfigStore } from '../store/configStore'
import { buildTrustedApiOrigins, isTrustedOrigin } from '../lib/trustedOrigins'

/**
 * Remove trailing slashes from a URL string.
 */
export function stripTrailingSlashes(url: string): string {
  const trimmed = url.trimEnd()
  if (trimmed.endsWith('/')) {
    return stripTrailingSlashes(trimmed.slice(0, -1))
  }
  return trimmed
}

/**
 * Returns the configured API base URL with trailing slashes removed.
 * Falls back to '/api' when no endpoint is configured.
 */
export function getBaseUrl(): string {
  const { config } = useConfigStore.getState()
  return stripTrailingSlashes(config.apiEndpoint === '' ? '/api' : config.apiEndpoint)
}

/**
 * Build the allowlist of trusted API origins from the deployment runtime config.
 *
 * **Note**: the returned array contains only the origin derived from the
 * runtime config endpoint. `localhost` / `127.0.0.1` are NOT in the returned
 * array — localhost trust is enforced inside `isTrustedAbsoluteUrl` via a
 * hostname comparison, not via the origins array. Reading this array and
 * checking for a localhost entry will never find one.
 *
 * Returns an empty array when the runtime config is not loaded yet — the
 * caller treats an empty allowlist as "no origin is trusted", which is the
 * safe outcome.
 *
 * Delegates to {@link buildTrustedApiOrigins} from `lib/trustedOrigins` to
 * avoid duplicating security-critical logic.
 */
export { buildTrustedApiOrigins as getTrustedApiOrigins }

/**
 * Return true when `requestUrl` resolves to a trusted API origin.
 *
 * Parsing failures are treated as unsafe (return false), so a malformed or
 * crafted URL value in the config store can never receive the auth header.
 *
 * Every URL is resolved against `window.location.origin` before being
 * classified, so same-origin is determined by the resolved origin rather than
 * by the shape of the string. Path-relative URLs (`/api/...`) resolve to the
 * current origin and are safe; spellings that only *look* relative but resolve
 * elsewhere — `//evil.example.com/...`, `/\evil.example.com/...` — are not.
 *
 * Delegates to {@link isTrustedOrigin} from `lib/trustedOrigins`.
 */
export { isTrustedOrigin as isTrustedRequestOrigin }

/**
 * Bounded lookback (in days) used for the widest ("90d") time range.
 *
 * The metrics backend iterates day-by-day (`for i in range(days)`) and some
 * endpoints (categories, sentiment) fan out into `categories × days` sequential
 * DynamoDB get_item calls. At 365 days that exceeds API Gateway's 29s timeout,
 * so those endpoints time out. We therefore cap the widest range at 90 days,
 * which also matches the aggregates table's 90-day TTL (data older than that
 * isn't retained anyway) and keeps every metrics endpoint within the timeout.
 * Must stay <= the backend's `validate_days` max (365) to avoid silent clamping.
 */
export const ALL_TIME_DAYS = 90

/**
 * Convert a time range string to a number of days.
 *
 * For the 'custom' range the caller supplies a rolling lookback in days
 * (`customDays`); when absent or invalid we fall back to the 7-day default.
 */
export function getDaysFromRange(range: string, customDays?: number | null): number {
  if (range === 'custom') {
    return customDays && customDays > 0 ? customDays : 7
  }

  switch (range) {
    case '24h': return 1
    case '48h': return 2
    case '7d': return 7
    case '30d': return 30
    case 'all': return ALL_TIME_DAYS
    default: return 7
  }
}

/**
 * Build auth headers with Cognito ID token.
 * Shared by client.ts (REST) and streamClient.ts (SSE).
 *
 * `targetUrl` is the URL the headers are about to be sent to, and it is
 * **required**: the Authorization header is attached only when that URL's
 * resolved origin is trusted (see {@link isTrustedOrigin}). This ensures that
 * even if a bad value reaches the config store — e.g. a stale persisted value
 * written by an older build — no bearer token is sent to an untrusted host.
 *
 * `targetUrl` comes first, and is required rather than optional, so that
 * omitting it is a compile error instead of a silent grant. An earlier
 * signature took it last and optional, defaulting to "trusted" when absent;
 * every caller did pass it, but a new call site could have opted out of the
 * check by accident and nothing would have failed. Pinned by test:
 * "requires the target URL, so the origin check cannot be skipped", which
 * stops compiling if the parameter goes back to being optional.
 */
export function getAuthHeaders(
  targetUrl: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  }

  if (isTrustedOrigin(targetUrl) && authService.isConfigured()) {
    const idToken = authService.getIdToken()
    if (idToken != null && idToken !== '') {
      headers['Authorization'] = idToken
    }
  }

  return headers
}


/**
 * Body-payload variant of the date-basis convention (issue #150): the
 * user's "Filter dates by" selection rides along in POST bodies for chat,
 * project research, and generation requests. 'review' adds the field;
 * the default 'imported' omits it so existing payloads stay identical.
 */
export function getDateBasisBodyParams(): { date_basis?: 'review' } {
  const { dateBasis } = useConfigStore.getState()
  return dateBasis === 'review' ? { date_basis: 'review' } : {}
}
