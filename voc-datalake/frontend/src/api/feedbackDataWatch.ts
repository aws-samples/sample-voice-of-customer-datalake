/**
 * @fileoverview Refresh the feedback family when a background job that rewrites
 * feedback finishes: a category reprocess, an erasure, an S3 import file.
 *
 * Those jobs run server-side for minutes and their panels already poll them, so
 * the moment a polled job leaves its running state is the moment the stored
 * feedback changed. Watching the query cache (rather than each panel) means the
 * refresh happens wherever the job was started — the Settings panel, the AI
 * assistant, another tab's poll that this tab later reads — and needs no call
 * site in the page files.
 *
 * A job seen for the first time records its status only: opening the page on a
 * job that finished yesterday refreshes nothing.
 *
 * @module api/feedbackDataWatch
 */
import { z } from 'zod'
import type { QueryCacheNotifyEvent, QueryClient } from '@tanstack/react-query'
import { invalidateFeedbackData } from './invalidateFeedbackData'

/** A job (or staged file) while it can still change data. Anything else is finished. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'pending'])

const JobSchema = z.object({ job_id: z.string().min(1), status: z.string() })
const FileSchema = z.object({ key: z.string().min(1), status: z.string() })

interface Tracked { readonly id: string; readonly status: string }

type JobReader = (data: unknown) => Tracked[]

/** A query key whose root is a string (every watched root is). */
const StringRootKeySchema = z.tuple([z.string()]).rest(z.unknown())

const jobOf = (raw: unknown): Tracked[] => {
  const parsed = JobSchema.safeParse(raw)
  return parsed.success ? [{ id: parsed.data.job_id, status: parsed.data.status }] : []
}

const jobsOf = (raw: unknown): Tracked[] => (Array.isArray(raw) ? raw.flatMap(jobOf) : [])

const FilesEnvelopeSchema = z.object({ files: z.array(z.unknown()) }).catch({ files: [] })

const filesOf = (raw: unknown): Tracked[] => FilesEnvelopeSchema.parse(raw).files.flatMap((file) => {
  const parsed = FileSchema.safeParse(file)
  return parsed.success ? [{ id: parsed.data.key, status: parsed.data.status }] : []
})

/** Query-key root → how to read its jobs. Roots from reprocessApi, sourceProfilesApi, S3ImportExplorer. */
const WATCHED_JOB_ROOTS: Readonly<Record<string, JobReader | undefined>> = {
  'category-reprocess-job': jobOf,
  'erasure-jobs': jobsOf,
  's3-import-files': filesOf,
}

/** Did any job that was seen live now report a finished status? Records every status seen. */
function recordAndDetectFinish(seen: Map<string, string>, root: string, jobs: readonly Tracked[]): boolean {
  return jobs.map(({ id, status }) => {
    const key = `${root}\u0000${id}`
    const previous = seen.get(key)
    seen.set(key, status)
    return previous !== undefined && LIVE_STATUSES.has(previous) && !LIVE_STATUSES.has(status)
  }).some(Boolean)
}

/** The root and its reader when `event` is a successful update of a watched job query. */
function watchedUpdate(event: QueryCacheNotifyEvent): { root: string; read: JobReader } | null {
  if (event.type !== 'updated' || event.action.type !== 'success') return null
  const key = StringRootKeySchema.safeParse(event.query.queryKey)
  if (!key.success) return null
  const [root] = key.data
  const read = Object.hasOwn(WATCHED_JOB_ROOTS, root) ? WATCHED_JOB_ROOTS[root] : undefined
  return read === undefined ? null : { root, read }
}

/** Start watching; returns the unsubscribe. `queryClient.clear()` does not stop it (the cache object stays). */
export function watchFeedbackJobs(queryClient: QueryClient): () => void {
  const seen = new Map<string, string>()
  return queryClient.getQueryCache().subscribe((event) => {
    const update = watchedUpdate(event)
    if (update === null) return
    if (recordAndDetectFinish(seen, update.root, update.read(event.query.state.data))) {
      void invalidateFeedbackData(queryClient)
    }
  })
}
