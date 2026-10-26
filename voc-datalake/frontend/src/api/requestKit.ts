/**
 * @fileoverview The two pieces every endpoint group of the API client shares.
 *
 * The groups (`adminEndpoints.ts`, `dataEndpoints.ts`) are factories that take
 * the request function rather than importing it from `./client`: `client.ts`
 * spreads them into `api` at module load, so an import back into `client.ts`
 * would be a cycle that breaks whichever side loads first.
 */

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
