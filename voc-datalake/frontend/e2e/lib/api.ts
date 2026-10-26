/**
 * Direct API access with a role's id token (the same header the SPA sends).
 * Used to resolve ids for screens, for the GET sweep, and to prove cleanup.
 * Response bodies are never written to disk by these helpers.
 */
import { MOCK, apiUrl, type Role } from './env'
import { isRecord } from './guards'
import { idTokenFor } from './session'

export interface ApiResult {
  status: number
  ms: number
  bytes: number
  body: unknown
}

export async function apiCall(role: Role, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const started = performance.now()
  const response = await fetch(`${apiUrl()}${path}`, {
    method,
    // The dev mock has no login: it answers every caller as the admin.
    headers: MOCK ? { 'Content-Type': 'application/json' } : { Authorization: idTokenFor(role), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return resultOf(response, started)
}

/** How much of a non-JSON body an `ApiResult` keeps (enough to read an error page, never a whole one). */
const TEXT_BODY_PREVIEW_CHARS = 300

/** A fetch response as an `ApiResult`: JSON body when it parses, else the start of the text. */
export async function resultOf(response: Response, started: number): Promise<ApiResult> {
  const text = await response.text()
  const ms = Math.round(performance.now() - started)
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(0, TEXT_BODY_PREVIEW_CHARS)
    }
  })()
  return { status: response.status, ms, bytes: text.length, body: parsed }
}

/** The array under `key` in a JSON object body (lenient: [] when absent). */
export function listOf(body: unknown, key: string): Array<Record<string, unknown>> {
  if (!isRecord(body)) return []
  const value = body[key]
  return Array.isArray(value) ? value.filter(isRecord) : []
}

export function stringField(item: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (item === undefined) return undefined
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}
