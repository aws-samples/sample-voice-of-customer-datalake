/**
 * @fileoverview The pieces every endpoint group and API module of the client shares.
 *
 * The groups (`adminEndpoints.ts`, `dataEndpoints.ts`) are factories that take
 * the request function rather than importing it from `./client`: `client.ts`
 * spreads them into `api` at module load, so an import back into `client.ts`
 * would be a cycle that breaks whichever side loads first.
 */

/** The options of a JSON request: `method`, plus `body` serialised when one is given. */
function jsonRequest(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) }
}

// The per-method request options every API module passes to fetchApi. Keep these
// names: scripts/check-mock-coverage.mjs reads a call's HTTP method off them.
export const post = (body?: unknown): RequestInit => jsonRequest('POST', body)
export const put = (body?: unknown): RequestInit => jsonRequest('PUT', body)
export const patch = (body?: unknown): RequestInit => jsonRequest('PATCH', body)
export const del = (): RequestInit => jsonRequest('DELETE')

/** The signature of `fetchApi` in `./client`. */
export type FetchApi = <T>(endpoint: string, options?: RequestInit) => Promise<T>

/**
 * Build URLSearchParams from an object, filtering out undefined/null values.
 * Accepts any object so domain interfaces (e.g. FeedbackListParams) can be
 * passed without requiring an index signature on the type.
 */
export function buildSearchParams(params: object): URLSearchParams {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null) {
      searchParams.set(key, String(value))
    }
  }
  return searchParams
}
