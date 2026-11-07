/**
 * @fileoverview The page's one notice hub (docs/realtime.md): whether push is live, who listens, and the
 * waits the polling loops use.
 *
 * The connection (realtime/connection.ts) feeds it; the views read it. Nothing here talks to the network,
 * so a view behaves exactly as before when push is off (the dev mock, an older deployment): `isRealtimeLive()`
 * is false and a watcher's `wait(ms)` is a plain sleep.
 *
 * Becoming live (the first connect, every reconnect) is announced as a `reconnect`: a notice may have
 * been missed while the socket was down, so every waiting loop polls at once.
 *
 * @module realtime/hub
 */
import type { RealtimeNotice } from './events'

type Listener = (notice: RealtimeNotice) => void
type ReconnectListener = () => void

const hub: { live: boolean; listeners: Set<Listener>; reconnects: Set<ReconnectListener> } = {
  live: false,
  listeners: new Set(),
  reconnects: new Set(),
}

/** True while the page is subscribed to its own channels. */
export function isRealtimeLive(): boolean {
  return hub.live
}

/** Called by the connection: live or not. A false → true change is announced as a reconnect. */
export function setRealtimeLive(live: boolean): void {
  const wasLive = hub.live
  hub.live = live
  if (!live || wasLive) return
  // A copy: a listener may unsubscribe itself while being called.
  for (const listener of Array.from(hub.reconnects)) listener()
}

/** Called by the connection for each validated notice. */
export function deliverNotice(notice: RealtimeNotice): void {
  for (const listener of Array.from(hub.listeners)) listener(notice)
}

/** Listen to every notice; returns the unsubscribe. */
export function onRealtimeNotice(listener: Listener): () => void {
  hub.listeners.add(listener)
  return () => { hub.listeners.delete(listener) }
}

/** Listen to every (re)connect; returns the unsubscribe. */
export function onRealtimeReconnect(listener: ReconnectListener): () => void {
  hub.reconnects.add(listener)
  return () => { hub.reconnects.delete(listener) }
}

export type WakeReason = 'notice' | 'reconnect' | 'timeout'

export interface RealtimeWatch {
  /**
   * Resolve on the next matching notice (or one that arrived since the last wait: none is lost between
   * two polls), on a reconnect, or after `fallbackMs`. Rejects with an AbortError when `signal` aborts.
   */
  wait: (fallbackMs: number, signal?: AbortSignal) => Promise<WakeReason>
  /** Stop listening (always call it when the loop ends). */
  close: () => void
}

function abortError(): Error {
  return new DOMException('The request was aborted.', 'AbortError')
}

/** Watch for notices matching `matches`, for one polling loop. */
export function watchRealtime(matches: (notice: RealtimeNotice) => boolean): RealtimeWatch {
  const state: { latched: WakeReason | null; wake: ((reason: WakeReason) => void) | null } = { latched: null, wake: null }
  const signalWake = (reason: WakeReason) => {
    if (state.wake === null) {
      state.latched = state.latched ?? reason
      return
    }
    state.wake(reason)
  }
  const stopNotices = onRealtimeNotice((notice) => { if (matches(notice)) signalWake('notice') })
  const stopReconnects = onRealtimeReconnect(() => { signalWake('reconnect') })

  const wait = (fallbackMs: number, signal?: AbortSignal): Promise<WakeReason> => new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    if (state.latched !== null) {
      const reason = state.latched
      state.latched = null
      resolve(reason)
      return
    }
    const finish = (reason: WakeReason) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      state.wake = null
      resolve(reason)
    }
    const onAbort = () => {
      clearTimeout(timer)
      state.wake = null
      reject(abortError())
    }
    const timer = setTimeout(() => { finish('timeout') }, fallbackMs)
    state.wake = finish
    signal?.addEventListener('abort', onAbort, { once: true })
  })

  return {
    wait,
    close: () => {
      stopNotices()
      stopReconnects()
    },
  }
}
