/**
 * @fileoverview Replace a page's prototype links before their signatures lapse.
 *
 * A prototype URL is a signed, session-scoped credential (see
 * `prototypeLinkLifetime`), and refetching the project is the re-sign mechanism:
 * the API mints a fresh signature on every read and never trusts a stored one. So
 * the whole job here is knowing *when* to ask again — the caller supplies the
 * asking.
 *
 * It has to happen **ahead of** expiry rather than in response to a 403, because
 * "Open in new tab" and "Download .html" are plain anchors: a click navigates
 * immediately and nothing can fetch a replacement first. A page that shows those
 * anchors without scheduling this is shipping a latent 403 — it works in review,
 * where nothing sits on screen for an hour, and fails for the reviewer who parks a
 * pitch on their second monitor.
 *
 * Extracted from `useProjectData` for the second consumer, the Prioritization
 * page, which reads every project at once and had no scheduling at all. A copy of
 * the effect would have been shorter to write and impossible to keep honest: the
 * lead time, the floor and the re-arm are one behaviour, and half of it in two
 * places is how one page ends up refreshing and the other silently not.
 *
 * Not the only protection, and not meant to be: neither query sets a `staleTime`,
 * so both inherit refetch-on-window-focus and a user who tabs away and back
 * re-signs that way. This covers the case with no user interaction to hook — a tab
 * left focused and untouched past the hour.
 *
 * @module components/usePrototypeLinkRefresh
 */
import { useEffect, useRef } from 'react'
import { earliestPrototypeExpiry, refreshDelayMs } from './prototypeLinkLifetime'
import type { ProjectDocument } from '../api/types'

/**
 * Schedule a re-sign shortly before the soonest prototype deadline in `documents`.
 *
 * Schedules nothing when there is no deadline to beat — no prototype, or no
 * readable signature — because a timer firing against nothing is a refetch loop
 * with extra steps. `refreshDelayMs` returning null is what says so, and this hook
 * does no arithmetic of its own.
 *
 * @param documents every document the page holds, prototypes or not;
 *   `earliestPrototypeExpiry` does the filtering. Undefined while the query is in
 *   flight, which is the same as having nothing to schedule.
 * @param onRefresh re-read the data these documents came from. Called from a timer,
 *   so it is held in a ref: the effect must re-arm when the DEADLINE moves and not
 *   when a caller's inline arrow gets a new identity, or a page that re-renders per
 *   keystroke would rebuild the timer on every one.
 */
export function usePrototypeLinkRefresh(
  documents: ReadonlyArray<Pick<ProjectDocument, 'document_type' | 'prototype_url'>> | undefined,
  onRefresh: () => void,
): void {
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onRefreshRef.current = onRefresh
  }, [onRefresh])

  // A number or null, so it is a stable effect dependency: the timer re-arms when
  // the deadline actually moves, which is exactly what a re-signed URL does, and
  // stays put through the identity churn of a refetch that changed nothing. The
  // scan is a filter over a handful of documents — cheaper than memoising it.
  const expiresAt = earliestPrototypeExpiry(documents ?? [])

  useEffect(() => {
    const delay = refreshDelayMs(expiresAt, Date.now())
    if (delay == null) return
    const timer = setTimeout(() => onRefreshRef.current(), delay)
    return () => clearTimeout(timer)
  }, [expiresAt])
}
