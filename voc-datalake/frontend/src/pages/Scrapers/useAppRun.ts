/**
 * @fileoverview One app card's own run (a review page, an app connector): its newest run, read on mount so a
 * reload still shows the last result; polled every 2 s while it runs; and Run now.
 *
 * Each card reads its OWN run (`GET /sources/status?run_status=<plugin>&app_id=<app>`, plus the run's
 * `execution_id` once Run now answered it), keyed per plugin and app ({@link appRunStatusKey}). The page used to
 * keep run statuses in component state only (gone on reload) and applied the plugin's latest run to every card of
 * that plugin, so four review pages run at once could show one another's result.
 * @module pages/Scrapers/useAppRun
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { appRunStatusKey } from '../../api/queryKeys'
import { useConfigStore } from '../../store/configStore'
import { parseRunRecord, parseRunStarted, type SourceRunStatus } from './sourceRunStatus'

/** How often a running card asks for its run. */
const RUN_POLL_MS = 2000
/**
 * A run row still `running` this long after it started never finished: its ingestor stopped before closing it
 * (an ingestor invocation lasts at most 15 minutes; a run in parts a little longer). The card says so instead of
 * spinning, stops polling, and lets Run now start again.
 */
export const STALE_RUN_MS = 60 * 60 * 1000

/** Whether `run` is running now (a `running` row younger than {@link STALE_RUN_MS}). */
export function isLiveRun(run: SourceRunStatus | null | undefined, now: number = Date.now()): boolean {
  if (run?.status !== 'running') return false
  const started = run.started_at === undefined ? Number.NaN : Date.parse(run.started_at)
  return Number.isNaN(started) || now - started < STALE_RUN_MS
}

/** The server could not read the run row (`status: unknown`): a failed poll, never "it never ran". */
class RunUnreadable extends Error {
  constructor() {
    super('The run status could not be read')
    this.name = 'RunUnreadable'
  }
}

async function readRun(pluginId: string, appId: string, executionId: string | undefined): Promise<SourceRunStatus | null> {
  const run = parseRunRecord(await api.getSourceRunStatus(pluginId, { appId, executionId }))
  if (run?.status === 'unknown') throw new RunUnreadable()
  return run
}

/** What the card shows the moment Run now is pressed, before the server's row is read. */
function startedRun(): SourceRunStatus {
  return { status: 'running', started_at: new Date().toISOString(), items_found: 0, errors: [] }
}

interface AppRun {
  /** The card's newest run (or the refused Run now), null when it never ran or cannot be read yet. */
  readonly lastRun: SourceRunStatus | null
  readonly isRunning: boolean
  readonly start: () => Promise<void>
}

/**
 * `appId` is what Run now sends as `app_id` (the App Store id, the package name, the review page's URL:
 * scraper-helpers.ts `getAppIdentifier`); the run row keeps it. `onRunApp` starts the run (`POST
 * /sources/{source}/run`).
 */
export function useAppRun(pluginId: string, appId: string,
  onRunApp: (pluginId: string, appId: string) => Promise<unknown>): AppRun {
  const queryClient = useQueryClient()
  const { config } = useConfigStore()
  const key = appRunStatusKey(pluginId, appId)
  // The run this card started (Run now's answer): polled by its id. Not in the key: the card's entry is its app's
  // newest run whichever way it is read, and a key per run would drop what the card shows each time.
  const [executionId, setExecutionId] = useState<string | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  // A Run now the server refused (403, 409, network): shown until the next one, never overwritten by a poll.
  const [refused, setRefused] = useState<SourceRunStatus | null>(null)

  const { data } = useQuery({
    queryKey: key,
    queryFn: () => readRun(pluginId, appId, executionId),
    // Not while Run now is in flight: a read before its row is written would answer the previous run.
    enabled: config.apiEndpoint !== '' && appId !== '' && !starting,
    refetchInterval: (query) => (isLiveRun(query.state.data) ? RUN_POLL_MS : false),
  })

  const start = async () => {
    setStarting(true)
    setRefused(null)
    setExecutionId(undefined)
    await queryClient.cancelQueries({ queryKey: key })
    queryClient.setQueryData(key, startedRun())
    try {
      setExecutionId(parseRunStarted(await onRunApp(pluginId, appId)))
    } catch (err: unknown) {
      setRefused({ status: 'error', items_found: 0, errors: [err instanceof Error ? err.message : String(err)] })
      // The optimistic `running` goes: the card's entry is read again (its previous run, if any).
      await queryClient.invalidateQueries({ queryKey: key })
    } finally {
      setStarting(false)
    }
  }

  const lastRun = refused ?? data ?? null
  return { lastRun, isRunning: starting || (refused === null && isLiveRun(data)), start }
}
