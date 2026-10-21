/**
 * @fileoverview The "newest date that has feedback" probe, powering the
 * empty-window fallback on the Dashboard and Categories pages.
 *
 * Its own module rather than more surface on `client.ts`, following the
 * `prioritizationRowsApi` / `projectsApi` / `votingSessionsApi` precedent —
 * `client.ts` sits at its `max-lines` budget (see the banner at the top of that
 * file), and this is one feature with two callers (both pages, via
 * `hooks/useEmptyWindowFallback`).
 *
 * Takes only the date basis, never a window: "latest" is independent of the
 * user's selected range, which is exactly what lets it answer when that range is
 * empty. The default 'imported' basis omits the query param entirely, matching
 * the convention `getDateRangeParams` follows so request URLs (and TanStack
 * Query keys) stay identical to the pre-basis behavior.
 *
 * @module api/metricsLatestDateApi
 */
import { fetchApi } from './client'
import type { DateBasis, LatestDateResponse } from './types'

/**
 * Fetch the most recent date that has feedback, on the given basis.
 *
 * @param dateBasis the basis the caller filters on, so the newest date is found
 *   on the SAME basis the page's metrics queries use. 'review' is sent as a
 *   query param; 'imported' (the default) sends nothing.
 */
export function getLatestDate(dateBasis?: DateBasis): Promise<LatestDateResponse> {
  const path =
    dateBasis === 'review'
      ? '/metrics/latest-date?date_basis=review'
      : '/metrics/latest-date'
  return fetchApi<LatestDateResponse>(path)
}
