/**
 * @fileoverview The Event API client: aws-amplify's `events` (AppSync Events over one WebSocket, the
 * app pool's Cognito token, automatic reconnect with refreshed tokens). Loaded lazily, only on a
 * deployment that has an Event API, so the dev mock and older deployments never fetch it.
 *
 * Amplify is configured for it in lib/amplify-config.ts (`API.Events`, auth mode `userPool`).
 *
 * @module realtime/amplifyTransport
 */
import { z } from 'zod'
import { ignoreRejection } from '../lib/rejections'
import type { RealtimeTransport } from './connection'

/** How long a subscribe may wait for AppSync's acknowledgement before it counts as failed. */
const READY_TIMEOUT_MS = 10_000

const ConnectionChangeSchema = z.object({
  payload: z.object({
    event: z.string(),
    data: z.object({ connectionState: z.string() }).loose(),
  }).loose(),
})

/** Amplify's ConnectionState values that mean "not delivering notices right now". */
const DISCONNECTED = new Set(['ConnectionDisrupted', 'ConnectionDisruptedPendingNetwork', 'Disconnected'])

/** `ready`, or a rejection after `ms` (the timer is cleared either way). */
async function within<T>(ready: Promise<T>, ms: number): Promise<T> {
  const timer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined }
  const expired = new Promise<never>((_resolve, reject) => {
    timer.id = setTimeout(() => { reject(new Error('subscribe not acknowledged')) }, ms)
  })
  try {
    return await Promise.race([ready, expired])
  } finally {
    clearTimeout(timer.id)
  }
}

/** Close a channel; a failure to close one the socket already dropped is nothing to act on. */
function closeQuietly(channel: { close: () => unknown }): void {
  const closing = channel.close()
  if (closing instanceof Promise) closing.catch(ignoreRejection)
}

export const amplifyTransport: RealtimeTransport = {
  async subscribe(channel, onData, onError) {
    const { events } = await import('aws-amplify/data')
    const opened = await events.connect(channel)
    const subscription = opened.subscribe({ next: onData, error: onError })
    try {
      await within(subscription.ready, READY_TIMEOUT_MS)
    } catch (error) {
      closeQuietly(opened)
      throw error
    }
    return () => { closeQuietly(opened) }
  },
  onConnectionChange(listener) {
    const state: { stop: (() => void) | null; stopped: boolean } = { stop: null, stopped: false }
    const listening = Promise.all([import('aws-amplify/utils'), import('aws-amplify/data')]).then(([utils, data]) => {
      if (state.stopped) return
      state.stop = utils.Hub.listen('api', (capsule: unknown) => {
        const parsed = ConnectionChangeSchema.safeParse(capsule)
        if (!parsed.success || parsed.data.payload.event !== data.CONNECTION_STATE_CHANGE) return
        const connectionState = parsed.data.payload.data.connectionState
        if (connectionState === 'Connected') listener(true)
        else if (DISCONNECTED.has(connectionState)) listener(false)
      })
    })
    // Without the socket's own state, the connection still learns of a drop from a channel error.
    listening.catch(ignoreRejection)
    return () => {
      state.stopped = true
      state.stop?.()
    }
  },
}
