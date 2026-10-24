/**
 * @fileoverview Custom error classes for the VoC frontend.
 * @module lib/errors
 */

/** Thrown when the user's session has expired or is invalid. */
export class AuthError extends Error {
  constructor(message = 'Session expired. Please login again.') {
    super(message)
    this.name = 'AuthError'
  }
}

/** Thrown when a required configuration is missing or not loaded. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Thrown when an API request fails with a non-OK status. */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message = `API Error: ${String(status)}`) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * The server's own reason a request failed — the `error`/`message` of its 4xx
 * body, e.g. "No feedback data found for the given filters" — or null when it
 * sent none (the ApiError then carries only its default `API Error: {status}`)
 * or the failure is not an ApiError at all (no answer, a bug).
 */
export function serverReason(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  return error.message === new ApiError(error.status).message ? null : error.message
}
