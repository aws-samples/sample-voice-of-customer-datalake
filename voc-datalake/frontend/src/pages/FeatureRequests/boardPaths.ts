/**
 * @fileoverview The feedback boards' addresses that hold no session (7.49.00; boardContext.ts builds the rest): the
 * in-app boards' path, the Insights tab's segment, and a request whose board is looked up by its id
 * (`<boards>/requests/<id>`). Pure, so the sign-in pages and a document's citations import it without the boards' API.
 *
 * @module pages/FeatureRequests/boardPaths
 */

/** Where the boards live in the app (`/board` is the standalone boards' path, pages/Board/boardHost.ts). */
export const APP_BOARDS_PATH = '/feature-requests'

/** The segment under the boards that opens a request whose board is not known (RequestLookup looks it up). */
export const REQUEST_LOOKUP_SEGMENT = 'requests'

/** The in-app Insights tab's segment (`/feature-requests/insights`). */
export const INSIGHTS_SEGMENT = 'insights'

/** One request when only its id is known (`/feature-requests/requests/fr_1`): its board is looked up, then opened. */
export function requestLookupPath(requestId: string, basePath: string = APP_BOARDS_PATH): string {
  return `${basePath}/${REQUEST_LOOKUP_SEGMENT}/${encodeURIComponent(requestId)}`
}
