/**
 * @fileoverview One source's schedule toggle and circuit breaker, read from the
 * page-wide `GET /sources/status` query.
 * @module pages/Settings/useSourceSchedule
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { sourcesStatusKey } from '../../api/queryKeys'
import { ownValue } from '../Scrapers/scraper-helpers'
import { CLOSED_CIRCUIT as CLOSED } from '../../api/sourcesStatusSchema'
import type { SourceCircuit, SourceStatus, SourcesStatus } from '../../api/sourcesStatusSchema'

/** Shared by every SourceCard (and the source erasure panel) so the page makes one /sources/status call. */
const SOURCES_STATUS_KEY = sourcesStatusKey()

interface ScheduleState {
  readonly enabled: boolean
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
  const [loading, setLoading] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetFailed, setResetFailed] = useState(false)
  const { data } = useQuery({
    queryKey: SOURCES_STATUS_KEY,
    queryFn: () => api.getSourcesStatus(),
    enabled: apiEndpoint !== '',
  })
  const own = data === undefined ? undefined : ownValue(data.sources, sourceId)

  const patchOwn = (patch: Partial<SourceStatus>) => {
    queryClient.setQueryData<SourcesStatus>(SOURCES_STATUS_KEY, (previous) => {
      const sources = previous?.sources ?? {}
      const current: SourceStatus = ownValue(sources, sourceId) ?? { enabled: false, circuit: CLOSED }
      return { sources: { ...sources, [sourceId]: { ...current, ...patch } } }
    })
  }

  const toggleEnabled = async (next: boolean) => {
    setLoading(true)
    try {
      const response = next ? await api.enableSource(sourceId) : await api.disableSource(sourceId)
      patchOwn(next ? { enabled: response.enabled, circuit: CLOSED } : { enabled: response.enabled })
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
      const response = await api.resetSource(sourceId)
      if (response.success) patchOwn({ circuit: response.circuit })
      else setResetFailed(true)
    } catch {
      setResetFailed(true)
    } finally {
      setResetting(false)
    }
  }

  return {
    serverStatus: { enabled: own?.enabled ?? false, loading, circuit: own?.circuit ?? CLOSED, resetting, resetFailed },
    toggleEnabled,
    resetCircuit,
  }
}
