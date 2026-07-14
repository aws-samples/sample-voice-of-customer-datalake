/**
 * Shared URL utilities used by API clients (client.ts, streamClient.ts).
 */
import { authService } from '../services/auth'
import { useConfigStore } from '../store/configStore'

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
 */
export function getAuthHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  }

  if (authService.isConfigured()) {
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
