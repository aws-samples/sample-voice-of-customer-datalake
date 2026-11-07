/**
 * @fileoverview Job-end notices for the React Query views that poll a job (docs/realtime.md → The SPA).
 *
 * A view that polls a job list or a job row keeps its poll as the fallback, slower while push is live
 * ({@link realtimePollInterval}), and calls {@link useRealtimeJobRefresh} with the queries to re-read:
 * they are invalidated at once when a matching `job` notice arrives, and on every (re)connect, since a
 * notice may have been missed while the socket was down. Without an Event API nothing here fires, and
 * the poll runs at its own pace exactly as before.
 *
 * @module realtime/jobRefresh
 */
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { RealtimeNotice } from './events'
import { isRealtimeLive, onRealtimeNotice, onRealtimeReconnect } from './hub'

/** The fallback poll of a job view while push is live: the notice brings the end, the poll covers a lost one. */
export const SUBSCRIBED_JOB_POLL_INTERVAL_MS = 10_000

/** The fallback interval while subscribed: `ms`, slowed to at least {@link SUBSCRIBED_JOB_POLL_INTERVAL_MS}. */
export function subscribedPollInterval(ms: number): number {
  return Math.max(ms, SUBSCRIBED_JOB_POLL_INTERVAL_MS)
}

/** `ms` without push; {@link subscribedPollInterval} while live. */
export function realtimePollInterval(ms: number): number {
  return isRealtimeLive() ? subscribedPollInterval(ms) : ms
}

/** Which job notices a view cares about; every field given must match. */
export interface JobNoticeMatch {
  /** One job type or several (the notice's `job_type`). */
  jobType?: string | readonly string[]
  /** The notice's `project_id`. */
  projectId?: string
  /** The notice's `job_id`. */
  jobId?: string
}

/** True for a `job` notice matching `match`. */
export function isMatchingJobNotice(notice: RealtimeNotice, match: JobNoticeMatch): boolean {
  if (notice.type !== 'job') return false
  const { jobType, projectId, jobId } = match
  if (jobId !== undefined && notice.job_id !== jobId) return false
  if (projectId !== undefined && notice.project_id !== projectId) return false
  if (jobType === undefined) return true
  const types: readonly string[] = typeof jobType === 'string' ? [jobType] : jobType
  return notice.job_type !== undefined && types.includes(notice.job_type)
}

/**
 * Invalidate `queryKeys` on a matching job notice and on every (re)connect, while `enabled`.
 * `match` and `queryKeys` may be new objects each render: the latest ones are used.
 */
export function useRealtimeJobRefresh(match: JobNoticeMatch, queryKeys: readonly QueryKey[], enabled = true): void {
  const queryClient = useQueryClient()
  const latest = useRef({ match, queryKeys })
  useEffect(() => {
    latest.current = { match, queryKeys }
  })
  useEffect(() => {
    const refresh = () => {
      for (const queryKey of latest.current.queryKeys) void queryClient.invalidateQueries({ queryKey })
    }
    const stops = enabled
      ? [
          onRealtimeNotice((notice) => { if (isMatchingJobNotice(notice, latest.current.match)) refresh() }),
          onRealtimeReconnect(refresh),
        ]
      : []
    return () => { for (const stop of stops) stop() }
  }, [enabled, queryClient])
}
