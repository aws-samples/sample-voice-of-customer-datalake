/**
 * @fileoverview One source's schedule toggle and circuit breaker, read from the
 * page-wide `GET /sources/status` query: the current workspace's breakers, or
 * in the deployment's scope (Administration → Data sources → Deployment,
 * workspace/configScope.ts) the deployment's, inside a workspace too.
 * @module pages/Settings/useSourceSchedule
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { sourcesStatusKey } from '../../api/queryKeys'
import { ownValue } from '../Scrapers/scraper-helpers'
import { CLOSED_CIRCUIT as CLOSED } from '../../api/sourcesStatusSchema'
import type { SourceCircuit, SourceStatus, SourcesStatus } from '../../api/sourcesStatusSchema'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { scopedKey, useConfigScope } from '../../workspace/configScope'

interface ScheduleState {
  readonly enabled: boolean
  /** False when the source has no schedule rule (`s3_import`, `synthetic_reviews`: their manifests declare none),
   *  so there is nothing to switch; undefined while unknown (loading, or the rule could not be described). */
  readonly exists?: boolean
  readonly loading?: boolean
  readonly circuit: SourceCircuit
  readonly resetting: boolean
  /** The last reset failed (the row could not be deleted); cleared by the next attempt. */
  readonly resetFailed: boolean
}

/**
 * Each card used to fetch the whole status map in its own effect, so N cards
 * meant N identical calls (5 in production, queuing from 1.5 s to 4.0 s). A
 * shared query key lets TanStack Query dedupe them; each card reads its own
 * entry, and a toggle or reset writes its answer back into that shared entry.
 *
 * Enabling also closes the breaker server-side (`PUT /sources/{source}/enable`),
 * so a successful enable writes a closed circuit back too.
 */
export function useSourceSchedule(sourceId: string, apiEndpoint: string): {
  serverStatus: ScheduleState
  toggleEnabled: (enabled: boolean) => Promise<void>
  resetCircuit: () => Promise<void>
} {
  const queryClient = useQueryClient()
  const scope = useConfigScope()
  const workspace = useCurrentWorkspace()
  // In the deployment's scope the card shows the deployment's breaker wherever the app is.
  const inWorkspace = scope === 'workspace' && workspace !== null
  // Shared by every SourceCard of the scope (and the source erasure panel) so the page makes one /sources/status call.
  const statusKey = scopedKey(sourcesStatusKey(), scope)
  const [loading, setLoading] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetFailed, setResetFailed] = useState(false)
  const { data } = useQuery({
    queryKey: statusKey,
    queryFn: () => api.getSourcesStatus(undefined, scope),
    enabled: apiEndpoint !== '',
  })
  const own = data === undefined ? undefined : ownValue(data.sources, sourceId)

  const patchOwn = (patch: Partial<SourceStatus>) => {
    queryClient.setQueryData<SourcesStatus>(statusKey, (previous) => {
      const sources = previous?.sources ?? {}
      const current: SourceStatus = ownValue(sources, sourceId) ?? { enabled: false, circuit: CLOSED }
      return { sources: { ...sources, [sourceId]: { ...current, ...patch } } }
    })
  }

  const toggleEnabled = async (next: boolean) => {
    setLoading(true)
    try {
      const response = next ? await api.enableSource(sourceId) : await api.disableSource(sourceId)
      // Enabling closes the DEPLOYMENT's breaker (the schedule is the deployment's, sent without X-Workspace-Id).
      // Outside a workspace that is the breaker the card shows; inside one the card shows the workspace's own,
      // which enabling leaves as it is, so the status is read again rather than shown closed.
      const closesShownBreaker = next && !inWorkspace
      patchOwn(closesShownBreaker ? { enabled: response.enabled, circuit: CLOSED } : { enabled: response.enabled })
      if (next && !closesShownBreaker) void queryClient.invalidateQueries({ queryKey: statusKey })
    } catch {
      // The toggle stays where it was; the card shows the server's last answer.
    } finally {
      setLoading(false)
    }
  }

  const resetCircuit = async () => {
    setResetting(true)
    setResetFailed(false)
    try {
      const response = await api.resetSource(sourceId, scope)
      if (response.success) patchOwn({ circuit: response.circuit })
      else setResetFailed(true)
    } catch {
      setResetFailed(true)
    } finally {
      setResetting(false)
    }
  }

  return {
    serverStatus: {
      enabled: own?.enabled ?? false, exists: own?.exists, loading, circuit: own?.circuit ?? CLOSED, resetting, resetFailed,
    },
    toggleEnabled,
    resetCircuit,
  }
}
