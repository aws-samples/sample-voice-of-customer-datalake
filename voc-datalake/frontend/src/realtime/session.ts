/**
 * @fileoverview App-lifetime wiring of push notifications (docs/realtime.md), next to the other
 * watchers in App.tsx:
 *
 * - connected once per signed-in session (the user's Cognito `sub`), closed on sign-out or a change
 *   of user; nothing at all on a deployment without an Event API (`getRealtimeEndpoints()` null);
 * - a run / plan notice refreshes that run's and plan's queries (the agents page, the plan card);
 *   their polling stays as it was, as the fallback;
 * - a (re)connect refreshes every agent and plan query on screen, since a notice may have been missed.
 *
 * Assist jobs (api/assistJobs.ts) and a reloaded assistant session (assistant/runtime/followServerRun.ts)
 * watch the hub themselves.
 *
 * @module realtime/session
 */
import type { QueryClient } from '@tanstack/react-query'
import { agentsKeys } from '../api/agentsApi'
import { plansKeys } from '../api/plansApi'
import { getRealtimeEndpoints } from '../runtimeConfig'
import { useAuthStore } from '../store/authStore'
import type { User } from '../store/authStore'
import { startRealtime, stopRealtime, type RealtimeTransport } from './connection'
import type { RealtimeNotice } from './events'
import { onRealtimeNotice, onRealtimeReconnect } from './hub'

function refreshFor(queryClient: QueryClient, notice: RealtimeNotice): void {
  if (notice.type === 'run') {
    for (const queryKey of [
      agentsKeys.run(notice.agent_id, notice.run_id), agentsKeys.runs(notice.agent_id),
      agentsKeys.detail(notice.agent_id), agentsKeys.list(),
    ]) void queryClient.invalidateQueries({ queryKey })
  }
  if (notice.type === 'plan') {
    void queryClient.invalidateQueries({ queryKey: plansKeys.detail(notice.plan_id) })
    void queryClient.invalidateQueries({ queryKey: plansKeys.list() })
  }
}

function subOf(user: User | null, isAuthenticated: boolean): string | null {
  return isAuthenticated && user?.sub !== undefined && user.sub !== '' ? user.sub : null
}

/**
 * Bind the subscription to the signed-in user and the query refreshes to the notices. `transport` is
 * the Event API client (the Amplify one by default, loaded lazily). Returns the unbind.
 */
export function watchRealtimeSession(queryClient: QueryClient, transport?: RealtimeTransport): () => void {
  const state: { sub: string | null } = { sub: null }
  const sync = (sub: string | null) => {
    if (sub === state.sub) return
    state.sub = sub
    if (sub === null || getRealtimeEndpoints() === null) {
      stopRealtime()
      return
    }
    if (transport !== undefined) {
      startRealtime(sub, transport)
      return
    }
    void import('./amplifyTransport').then(({ amplifyTransport }) => {
      if (state.sub === sub) startRealtime(sub, amplifyTransport)
    })
  }
  const auth = useAuthStore.getState()
  sync(subOf(auth.user, auth.isAuthenticated))
  const stopAuth = useAuthStore.subscribe((next) => { sync(subOf(next.user, next.isAuthenticated)) })
  const stopNotices = onRealtimeNotice((notice) => { refreshFor(queryClient, notice) })
  const stopReconnects = onRealtimeReconnect(() => {
    void queryClient.invalidateQueries({ queryKey: plansKeys.all() })
    void queryClient.invalidateQueries({ queryKey: agentsKeys.list() })
  })
  return () => {
    stopAuth()
    stopNotices()
    stopReconnects()
    stopRealtime()
    state.sub = null
  }
}
