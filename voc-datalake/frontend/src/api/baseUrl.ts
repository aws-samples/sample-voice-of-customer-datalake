/**
 * Shared URL utilities used by API clients (client.ts, assistant/agui/client.ts).
 */
import { authService } from '../services/auth'
import { useConfigStore } from '../store/configStore'
import { isTrustedOrigin } from '../lib/trustedOrigins'

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
 * Lookback (in days) of the widest fixed preset ("90d"). The "All time" preset
 * (`'all'`) sends 0, and the custom picker takes up to MAX_CUSTOM_DAYS (or 0);
 * feedback is never deleted, so every one of them is served.
 */
export const WIDEST_PRESET_DAYS = 90

/** Custom lookback the user types to mean "all time" — sent to the API as-is. */
export const ALL_TIME_CUSTOM_DAYS = 0

/**
 * Largest custom lookback the picker accepts. Equals the backend's
 * `MAX_FEEDBACK_WINDOW_DAYS` (lambda/shared/api.py) and the stream Lambda's
 * `MAX_WINDOW_DAYS`; pinned to both by `daysWindow.lockstep.test.ts`.
 */
export const MAX_CUSTOM_DAYS = 9999

/** A custom lookback the picker can store: a whole number from 0 (all time) to MAX_CUSTOM_DAYS. */
function isCustomDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= ALL_TIME_CUSTOM_DAYS && value <= MAX_CUSTOM_DAYS
}

/** Parse a days text input into a valid custom lookback (0 = all time), or null when invalid. */
export function parseCustomDaysInput(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const n = Number(value.trim())
  return isCustomDays(n) ? n : null
}

/**
 * Convert a time range string to the number of days to request.
 *
 * For the 'custom' range the caller supplies a rolling lookback in days
 * (`customDays`), sent as-is: 0 means all time (the backend resolves it to the
 * span since the earliest stored feedback). When absent or invalid we fall back
 * to the 7-day default.
 */
export function getDaysFromRange(range: string, customDays?: number | null): number {
  if (range === 'custom') {
    return isCustomDays(customDays) ? customDays : 7
  }

  switch (range) {
    case '24h': return 1
    case '48h': return 2
    case '7d': return 7
    case '30d': return 30
    case '90d': return WIDEST_PRESET_DAYS
    case 'all': return ALL_TIME_CUSTOM_DAYS
    default: return 7
  }
}

/**
 * Build auth headers with Cognito ID token.
 * Shared by client.ts (REST) and assistant/agui/client.ts (SSE).
 *
 * `targetUrl` is the URL the headers are about to be sent to, and it is
 * **required**: the Authorization header is attached only when that URL's
 * resolved origin is trusted (see {@link isTrustedOrigin}). This ensures that
 * even if a bad value reaches the config store — e.g. a stale persisted value
 * written by an older build — no bearer token is sent to an untrusted host.
 *
 * `targetUrl` is required and comes first because an earlier signature took it
 * last and optional, defaulting to "trusted" when absent. Treat that as the
 * declared contract and not as the enforcement: `targetUrl?: string` with
 * `isTrustedOrigin(targetUrl ?? '')` type-checks cleanly and restores the
 * permissive default, since `''` resolves same-origin. The enforcement is the
 * runtime precondition below.
 */
export function getAuthHeaders(
  targetUrl: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  }

  // Refuse an absent or empty target instead of resolving it: `''` resolves to
  // the current origin, and so does the `'undefined'` a missing argument
  // stringifies to, so both would otherwise be trusted. A precondition on the
  // argument, deliberately not a rule inside `isTrustedOrigin` — that function
  // answers "where does this resolve?", which is a different question from "is
  // there a target at all?".
  //
  // The `typeof` half is not redundant despite the declared type: test files are
  // excluded from every typecheck gate and vitest transpiles without
  // type-checking, so an argument-less call is reachable at runtime. Pinned by
  // the "empty" / "missing entirely" tests in baseUrl.test.ts.
  const hasTarget = typeof targetUrl === 'string' && targetUrl !== ''

  if (hasTarget && isTrustedOrigin(targetUrl) && authService.isConfigured()) {
    const idToken = authService.getIdToken()
    if (idToken != null && idToken !== '') {
      headers['Authorization'] = idToken
    }
  }

  return headers
}


/**
 * Body-payload variant of the date-basis convention (issue #150): the
 * user's "Filter dates by" selection rides along in POST bodies for
 * project research, and generation requests. 'review' adds the field;
 * the default 'imported' omits it so existing payloads stay identical.
 */
export function getDateBasisBodyParams(): { date_basis?: 'review' } {
  const { dateBasis } = useConfigStore.getState()
  return dateBasis === 'review' ? { date_basis: 'review' } : {}
}
