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
 * Convert a time range string to a number of days.
 */
export function getDaysFromRange(range: string, customRange?: {
  start: string;
  end: string
} | null): number {
  if (range === 'custom' && customRange) {
    const start = new Date(customRange.start)
    const end = new Date(customRange.end)
    const diffTime = Math.abs(end.getTime() - start.getTime())
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1
  }

  switch (range) {
    case '24h': return 1
    case '48h': return 2
    case '7d': return 7
    case '30d': return 30
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
