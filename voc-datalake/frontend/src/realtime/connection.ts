/**
 * @fileoverview One subscription per signed-in session (docs/realtime.md): the caller's own three
 * channels, `/jobs/<sub>`, `/chat/<sub>` and `/runs/<sub>`, through a {@link RealtimeTransport}.
 *
 * The transport keeps the socket alive and reconnects it (with fresh tokens) on its own; this module
 * retries a failed connect or subscribe with backoff, reports the live state to the hub, and drops
 * every delivery that is not a valid notice.
 *
 * @module realtime/connection
 */
import { parseNotice } from './events'
import { deliverNotice, setRealtimeLive } from './hub'

export const REALTIME_CHANNELS = ['jobs', 'chat', 'runs'] as const

/** What the connection needs of the Event API client (realtime/amplifyTransport.ts in the app). */
export interface RealtimeTransport {
  /** Subscribe to `channel`; resolves once AppSync acknowledged it, with the function that closes it. */
  subscribe: (channel: string, onData: (data: unknown) => void, onError: (error: unknown) => void) => Promise<() => void>
  /** The socket's own state changes (a dropped connection, its automatic reconnect). Returns the unsubscribe. */
  onConnectionChange: (listener: (connected: boolean) => void) => () => void
}

/** Wait before the next attempt after a failed connect (then the last value, every time). */
export const RETRY_DELAYS_MS = [1000, 2000, 5000, 15_000, 30_000, 60_000] as const

interface Connection {
  generation: number
  closers: (() => void)[]
  timer: ReturnType<typeof setTimeout> | undefined
  stopWatching: (() => void) | undefined
}

const connection: Connection = { generation: 0, closers: [], timer: undefined, stopWatching: undefined }

function closeChannels(): void {
  for (const close of connection.closers.splice(0)) {
    try {
      close()
    } catch {
      // Closing a channel the socket already dropped: nothing to do.
    }
  }
}

function retry(generation: number, sub: string, transport: RealtimeTransport, attempt: number): void {
  const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
  clearTimeout(connection.timer)
  connection.timer = setTimeout(() => { void connectChannels(generation, sub, transport, attempt + 1) }, delay)
}

async function connectChannels(generation: number, sub: string, transport: RealtimeTransport, attempt: number): Promise<void> {
  const onError = () => {
    // Only an OPEN session reacts (once: the first error closes every channel); a failure while
    // subscribing is the allSettled below.
    if (generation !== connection.generation || connection.closers.length !== REALTIME_CHANNELS.length) return
    setRealtimeLive(false)
    closeChannels()
    retry(generation, sub, transport, 0)
  }
  const onData = (data: unknown) => {
    const notice = parseNotice(data)
    if (notice !== null) deliverNotice(notice)
  }
  const opened = await Promise.allSettled(
    REALTIME_CHANNELS.map((namespace) => transport.subscribe(`/${namespace}/${sub}`, onData, onError)),
  )
  const closers = opened.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  if (generation !== connection.generation) {
    for (const close of closers) close()
    return
  }
  connection.closers.push(...closers)
  if (closers.length < REALTIME_CHANNELS.length) {
    closeChannels()
    retry(generation, sub, transport, attempt)
    return
  }
  setRealtimeLive(true)
}

/** Subscribe `sub`'s channels (an earlier session's are closed first). */
export function startRealtime(sub: string, transport: RealtimeTransport): void {
  stopRealtime()
  const generation = connection.generation
  connection.stopWatching = transport.onConnectionChange((connected) => {
    if (generation === connection.generation && connection.closers.length === REALTIME_CHANNELS.length) {
      setRealtimeLive(connected)
    }
  })
  void connectChannels(generation, sub, transport, 0)
}

/** Close everything (sign-out, a different user); the views fall back to polling. */
export function stopRealtime(): void {
  connection.generation += 1
  clearTimeout(connection.timer)
  connection.timer = undefined
  connection.stopWatching?.()
  connection.stopWatching = undefined
  closeChannels()
  setRealtimeLive(false)
}
