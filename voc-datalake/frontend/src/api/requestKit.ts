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
// A DELETE body is rare: a person's erasure states its legal basis in one (docs/participants.md).
export const del = (body?: unknown): RequestInit => jsonRequest('DELETE', body)

/** The signature of `fetchApi` in `./client` (`scope`: baseUrl.ts `RequestScope`, default `'workspace'`). */
export type FetchApi = <T>(endpoint: string, options?: RequestInit, scope?: 'workspace' | 'deployment') => Promise<T>

/**
 * The source whose Run now is the deployment's alone: the S3 import's bucket is not keyed by workspace, so the
 * integrations API refuses its Run now in a workspace (400) and the web app sends it without `X-Workspace-Id`.
 */
const DEPLOYMENT_ONLY_RUN_SOURCE = 's3_import'

/** The scope of a source's Run now: `'deployment'` for {@link DEPLOYMENT_ONLY_RUN_SOURCE}, else none given (the
 *  default, the current workspace's). */
export const runScope = (source: string): 'deployment' | undefined =>
  (source === DEPLOYMENT_ONLY_RUN_SOURCE ? 'deployment' : undefined)

/** `cursor=…`, the query of a page after the first of a `next_cursor` list. */
export function cursorQuery(cursor: string): string {
  return new URLSearchParams({ cursor }).toString()
}

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
