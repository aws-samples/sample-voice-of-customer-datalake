/**
 * @fileoverview Empty-window fallback: widen to the most recent data that exists.
 *
 * The Dashboard and Categories pages filter on a rolling "last N days" window
 * ending today. When a deployment's newest data is older than that window — the
 * common case for a demo instance, or any instance whose ingestion has paused —
 * every metrics query returns zero and the page renders an empty state over data
 * that is simply out of range. This hook turns that into: "no data in the
 * selected range, here is your most recent data instead", with a banner.
 *
 * It is a SHARED hook rather than per-page logic because both pages need the
 * identical decision (is the primary result empty? what is the newest date? what
 * window reaches it?) and the identical honesty requirement (the effective window
 * is reflected in query keys and surfaced to the user, never silently swapped
 * under the selected-range label).
 *
 * Deliberately does NOT fetch any metrics itself — it only resolves the
 * EFFECTIVE date params each page then threads into its own queries. That keeps
 * this hook agnostic to which metrics a page reads (Dashboard reads five
 * endpoints, Categories reads others) and leaves each page's existing query
 * wiring in place.
 *
 * @module hooks/useEmptyWindowFallback
 */
import { useQuery } from '@tanstack/react-query'
import { differenceInCalendarDays, parseISO, isValid } from 'date-fns'
import { ALL_TIME_DAYS } from '../api/client'
import { getLatestDate } from '../api/metricsLatestDateApi'
import type { DateRangeParams, DateBasis } from '../api/client'

/**
 * What the UI shows when the fallback is active. `null` means no fallback (the
 * selected window had data, or there is genuinely no data to fall back to).
 */
export interface EmptyWindowFallback {
  /** Newest populated date, 'YYYY-MM-DD', that the effective window reaches. */
  latestDate: string
  /** The widened lookback the page's queries are actually using. */
  days: number
}

export interface EmptyWindowFallbackResult {
  /**
   * The window the page should query with. Equal to the caller's `dateParams`
   * unless the fallback is active, in which case it is widened to reach
   * `fallback.latestDate`.
   */
  effectiveDateParams: DateRangeParams
  /** Banner descriptor, or `null` when no fallback is in effect. */
  fallback: EmptyWindowFallback | null
  /** True while the latest-date probe is in flight (selected window was empty). */
  isResolving: boolean
}

/**
 * Days of lookback (a window ending today) needed to include `latestDate`.
 *
 * A window of N days covers [today-(N-1), today], so reaching a date D needs
 * `(today - D) + 1` days. Clamped to [1, ALL_TIME_DAYS]: the backend caps the
 * window at ALL_TIME_DAYS (90) — past that, aggregate rows have aged out and no
 * complete answer exists — and a date today or in the future needs just 1 day.
 * Returns null for an unparseable date so the caller declines to fall back
 * rather than querying a nonsense window.
 */
export function daysToReach(latestDate: string, today: Date = new Date()): number | null {
  const parsed = parseISO(latestDate)
  if (!isValid(parsed)) return null
  const diff = differenceInCalendarDays(today, parsed)
  if (diff < 0) return 1
  return Math.min(diff + 1, ALL_TIME_DAYS)
}

/**
 * Resolve the effective window for a page whose selected window may be empty.
 *
 * @param dateParams the user's selected window (from `getDateRangeParams`)
 * @param isEmpty    true when the page's primary query resolved with no data
 * @param isLoading  true while that primary query is still loading (suppresses
 *                   the probe so an in-flight page never flashes a fallback)
 * @param apiEndpoint configured endpoint; gates the probe (see useSummaryQuery
 *                   for why this is truthiness-tested rather than length)
 * @param dateBasis  the basis the page filters on, so the probe finds the newest
 *                   date on the SAME basis the queries use
 */
export function useEmptyWindowFallback(
  dateParams: DateRangeParams,
  isEmpty: boolean,
  isLoading: boolean,
  apiEndpoint: string | undefined,
  dateBasis: DateBasis,
): EmptyWindowFallbackResult {
  // Probe only once the primary query has resolved AND come back empty. While it
  // loads, isEmpty is reported false by callers, so the probe stays disabled and
  // the page shows its normal loading state rather than a premature fallback.
  const shouldProbe = !!apiEndpoint && isEmpty && !isLoading

  const { data, isLoading: probeLoading } = useQuery({
    queryKey: ['latest-date', dateBasis],
    queryFn: () => getLatestDate(dateBasis),
    enabled: shouldProbe,
  })

  const noFallback: EmptyWindowFallbackResult = {
    effectiveDateParams: dateParams,
    fallback: null,
    isResolving: shouldProbe && probeLoading,
  }

  if (!shouldProbe) return noFallback

  const latestDate = data?.latest_date ?? null
  if (latestDate === null) return noFallback

  const days = daysToReach(latestDate)
  // Fall back only when the newest data is OUTSIDE the window the user already
  // selected. If it is within the selected window, an empty result is the honest
  // answer (e.g. a source filter matched nothing) and widening would
  // misleadingly surface unrelated data. `daysToReach` returning null (an
  // unparseable date) also declines the fallback.
  const selectedDays = dateParams.days ?? 0
  if (days === null || days <= selectedDays) return noFallback

  return {
    // Preserve date_basis; only the lookback widens.
    effectiveDateParams: { ...dateParams, days },
    fallback: { latestDate, days },
    isResolving: false,
  }
}
