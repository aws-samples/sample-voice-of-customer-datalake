/**
 * @fileoverview The Product tab's Extract (7.104.00, docs/project-workspace.md → Product tab): `POST …/product-extract`
 * starts one `extract_product_description` job, which the Background Jobs panel lists like every project job; this
 * hook reads the same jobs list (the page's `projectJobsKey` entry) for the newest extract, so the Sources card can show
 * its step and time while it runs and its reason when it failed, and the review reads the proposal once it finished.
 *
 * After a `timed_out` job the person may retry at `xhigh` (owner decision 10): the choice is theirs, nothing retries
 * by itself, since every run is billed. A job still pending or running that wrote no progress for the Background Jobs
 * panel's `STALE_THRESHOLD_MS` (pages/ProjectDetail/jobStaleness.ts, the one rule) is stale, as that panel shows it:
 * not running, no longer polled, and the person may start another; until the server's lock lets it go (about 16
 * minutes after the stopped one started), Try again's refusal says when to try (`busyStale`).
 *
 * @module pages/ProjectDetail/useProductExtract
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { projectJobsKey } from '../../api/projectQueryKeys'
import { apiErrorCode } from '../../lib/errors'
import { noCleanup } from '../../hooks/noCleanup'
import { realtimePollInterval } from '../../realtime/jobRefresh'
import { isStaleJob } from './jobStaleness'
import { productProposalKey } from './useProductProposal'
import type { ProductExtractEffort, ProjectJob } from '../../api/projectTypes'

const EXTRACT_JOB_TYPE = 'extract_product_description'
const POLL_MS = 3000
const SECOND_MS = 1000

/** The start's refusals (shared/product_proposal_routes.py), each with what the person reads. */
const START_ERRORS: Readonly<Record<string, string>> = {
  no_ready_sources: 'product.extract.errors.noReadySources',
  extract_running: 'product.extract.errors.busy',
  rate_limited: 'product.extract.errors.rateLimited',
}

/** The newest extract job of the list, or null. */
export function latestExtractJob(jobs: readonly ProjectJob[]): ProjectJob | null {
  const extracts = jobs.filter((job) => job.job_type === EXTRACT_JOB_TYPE)
  return extracts.reduce<ProjectJob | null>(
    (newest, job) => (newest === null || job.created_at > newest.created_at ? job : newest), null)
}

/** A pending or running job that still writes progress (a stale one, `isStaleJob`, is taken for gone). */
const isRunning = (job: ProjectJob | null, now: number): boolean =>
  (job?.status === 'pending' || job?.status === 'running') && !isStaleJob(job, now)

/** The clock, ticking each second while `live` holds at its last reading (so a job that turns stale stops it). */
function useExtractClock(live: (now: number) => boolean): number {
  const [now, setNow] = useState(() => Date.now())
  const ticking = live(now)
  useEffect(() => {
    if (!ticking) return noCleanup
    const timer = globalThis.setInterval(() => setNow(Date.now()), SECOND_MS)
    return () => globalThis.clearInterval(timer)
  }, [ticking])
  return now
}

/** Whole seconds from `from` (an ISO time) to `now`. */
function elapsedSeconds(from: string | undefined, now: number): number {
  const start = from === undefined ? Number.NaN : Date.parse(from)
  return Number.isNaN(start) ? 0 : Math.max(0, Math.floor((now - start) / SECOND_MS))
}

/** The newest extract job of the page's jobs list, polled while it runs or while the started one is not listed yet;
 * a stale one is not polled (the Background Jobs panel shows it stale, `STALE_THRESHOLD_MS`). */
function useNewestExtract(projectId: string, awaiting: string | null): ProjectJob | null {
  const jobs = useQuery({
    queryKey: projectJobsKey(projectId),
    queryFn: () => projectsApi.getJobs(projectId),
    refetchInterval: (query) => {
      const newest = latestExtractJob(query.state.data?.jobs ?? [])
      const listed = awaiting === null || newest?.job_id === awaiting
      return !listed || isRunning(newest, Date.now()) ? realtimePollInterval(POLL_MS) : false
    },
  })
  return latestExtractJob(jobs.data?.jobs ?? [])
}

/** A finished extract's proposal: read once, when this tab first sees the job completed. */
function useProposalOnDone(projectId: string, job: ProjectJob | null): void {
  const queryClient = useQueryClient()
  const seenDone = useRef<string | null>(null)
  useEffect(() => {
    if (job?.status !== 'completed' || seenDone.current === job.job_id) return
    seenDone.current = job.job_id
    void queryClient.invalidateQueries({ queryKey: productProposalKey(projectId) })
  }, [job, projectId, queryClient])
}

/** The start's refusal as a locale key, or null. A 409 `extract_running` while the newest extract reads stale is its
 * lock, which holds an extract that stopped until about 16 minutes after it started (shared/product_proposals.py
 * `LOCK_STALE_SECONDS`; its answer carries no time): said so, with when to try again (`busyStale`). */
function startErrorKey(failed: boolean, error: unknown, stale: boolean): string | null {
  if (!failed) return null
  const code = apiErrorCode(error) ?? ''
  if (code === 'extract_running' && stale) return 'product.extract.errors.busyStale'
  return START_ERRORS[code] ?? 'product.extract.errors.generic'
}

export function useProductExtract(projectId: string, onJobStarted?: () => void) {
  const { i18n } = useTranslation('projectDetail')
  const queryClient = useQueryClient()
  // The started job until the jobs list names it (the list is read without ConsistentRead): running all the same.
  const [awaiting, setAwaiting] = useState<string | null>(null)
  const job = useNewestExtract(projectId, awaiting)
  // Adjusted during render, as React recommends over an effect: the list names the started job now.
  if (awaiting !== null && job?.job_id === awaiting) setAwaiting(null)
  const waiting = awaiting !== null && job?.job_id !== awaiting
  const now = useExtractClock((at) => waiting || isRunning(job, at))
  const stale = job !== null && !waiting && isStaleJob(job, now)
  const running = waiting || isRunning(job, now)
  const elapsed = elapsedSeconds(job?.created_at, now)
  useProposalOnDone(projectId, job)

  const start = useMutation({
    mutationFn: (effort: ProductExtractEffort) =>
      projectsApi.startProductExtract(projectId, { response_language: i18n.language, effort }),
    onSuccess: (started) => {
      setAwaiting(started.job_id)
      onJobStarted?.()
      void queryClient.invalidateQueries({ queryKey: projectJobsKey(projectId) })
    },
  })
  return {
    /** The newest extract job, or null when the project has none listed. */
    job,
    running,
    /** The newest extract is still pending or running but wrote no progress for `STALE_THRESHOLD_MS`: taken for
     * gone, as the Background Jobs panel shows it, so the person may start another. */
    stale,
    elapsed,
    startError: startErrorKey(start.isError, start.error, stale),
    pending: start.isPending,
    start: (effort: ProductExtractEffort = 'max') => start.mutate(effort),
  }
}

export type ProductExtract = ReturnType<typeof useProductExtract>
