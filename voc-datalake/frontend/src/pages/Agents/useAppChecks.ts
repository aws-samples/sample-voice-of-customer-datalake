/**
 * @fileoverview The installation checks made on Agents → Connections in this session (7.52.00): an App's Check
 * installation, the header's Check now (every installed App), and a row's Create label (the check creates a missing
 * `voc-agent` label again). `POST /agents/engineering/github-apps/<id>/check` answers which repositories the
 * installation covers and which connections it no longer does, and what followed for the GitHub Issues source; each
 * check records the slug GitHub reports and may bring repositories into the source, so the Apps and the source's view
 * are read again after it.
 *
 * The API keeps no time of the last check (ux-agents-redesign D4): "Checked …" is the time of a check made here, and
 * none is said before one.
 *
 * @module pages/Agents/useAppChecks
 */
import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { githubAppsApi, githubAppsKeys } from '../../api/githubAppsApi'
import { issuesSourceKeys } from '../../api/issuesSourceApi'
import type { InstallationCheck } from '../../api/githubAppsApi'

/** One App's last check of this session: when, and what it found or why it failed. */
export type AppCheckRecord =
  | { readonly at: string; readonly result: InstallationCheck; readonly error: null }
  | { readonly at: string; readonly result: null; readonly error: unknown }

export interface AppChecks {
  /** Each App's last check, by its id. */
  readonly records: ReadonlyMap<string, AppCheckRecord>
  /** The Apps whose check is on its way. */
  readonly running: ReadonlySet<string>
  /** Each App's last successful check, by its id (what the page's state reads). */
  readonly results: ReadonlyMap<string, InstallationCheck>
  readonly check: (appId: string) => Promise<void>
  readonly checkAll: (appIds: readonly string[]) => Promise<void>
}

const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> => new Map(map).set(key, value)

export function useAppChecks(): AppChecks {
  const queryClient = useQueryClient()
  const [records, setRecords] = useState<ReadonlyMap<string, AppCheckRecord>>(() => new Map())
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set())
  const check = useCallback(async (appId: string) => {
    setRunning((current) => new Set(current).add(appId))
    try {
      const result = await githubAppsApi.check(appId)
      setRecords((current) => withEntry(current, appId, { at: new Date().toISOString(), result, error: null }))
    } catch (error: unknown) {
      setRecords((current) => withEntry(current, appId, { at: new Date().toISOString(), result: null, error }))
    } finally {
      setRunning((current) => {
        const next = new Set(current)
        next.delete(appId)
        return next
      })
      void queryClient.invalidateQueries({ queryKey: githubAppsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: issuesSourceKeys.view() })
    }
  }, [queryClient])
  const checkAll = useCallback(async (appIds: readonly string[]) => {
    await Promise.all(appIds.map((appId) => check(appId)))
  }, [check])
  const results = new Map([...records].flatMap(([appId, record]) => (record.result === null ? [] : [[appId, record.result] as const])))
  return { records, running, results, check, checkAll }
}
