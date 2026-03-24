import type { ReviewSubmission, SubmitResponse, StatusResponse } from './types'
import { getConfig, getTokens } from './storage'

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const tokens = await getTokens()
  if (!tokens) {
    throw new ApiError('Not authenticated', 401)
  }

  // Check if token is expired (with 5 min buffer)
  if (tokens.expiresAt < Date.now() + 5 * 60 * 1000) {
    throw new ApiError('Token expired — please sign in again', 401)
  }

  // JWT tokens start with "eyJ" — sanity check
  if (!tokens.idToken.startsWith('eyJ')) {
    console.error('[VoC] Stored idToken does not look like a JWT:', tokens.idToken.substring(0, 20))
    throw new ApiError('Invalid token format — please sign in again', 401)
  }

  return {
    'Content-Type': 'application/json',
    Authorization: tokens.idToken,
  }
}

async function getBaseUrl(): Promise<string> {
  const config = await getConfig()
  if (!config?.apiEndpoint) {
    throw new ApiError('API endpoint not configured', 400)
  }
  return config.apiEndpoint.replace(/\/+$/, '')
}

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const baseUrl = await getBaseUrl()
  const headers = await getAuthHeaders()

  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: { ...headers, ...options?.headers },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new ApiError(
      `API error ${response.status}: ${body}`,
      response.status,
    )
  }

  return response.json() as Promise<T>
}

/** Submit reviews to the backend */
export async function submitReviews(
  submission: ReviewSubmission,
): Promise<SubmitResponse> {
  return fetchApi<SubmitResponse>('/extension/reviews', {
    method: 'POST',
    body: JSON.stringify(submission),
  })
}

/** Check extension API status */
export async function getStatus(): Promise<StatusResponse> {
  return fetchApi<StatusResponse>('/extension/status')
}
