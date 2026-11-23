/**
 * @fileoverview One voice session's WebSocket to the relay (docs/voice-personas.md), outside React so a re-render
 * never opens a second one: the presigned `connect_url` is single-use (the relay refuses a second connection with
 * 1008), so `connect` opens it once per connection object and a later call only re-attaches. `release` (a component
 * unmounting) ends the session on the next tick unless the component came straight back (React's development
 * double-mount), so a real close always ends it and a remount never does.
 *
 * - Binary frames are the persona's voice (played), JSON frames the relay's messages (`relayMessageSchema`; anything
 *   else is ignored). `ready` starts the microphone, `interrupted` flushes playback (barge-in), `ended` closes.
 * - `end` asks the relay to finish (`{type: 'end'}`: it flushes the transcript and says `ended`) and closes anyway
 *   after `END_GRACE_MS`.
 * - The socket's close, whatever caused it, releases the microphone and reports once, with the reason the relay
 *   gave, else `disconnected`. After the session's time limit, its cost cap or the month's budget the persona's
 *   goodbye, already queued, plays out (at most `GOODBYE_DRAIN_MS`) before the audio is released; any other end
 *   silences it at once.
 *
 * @module pages/ProjectDetail/voice/voiceConnection
 */
import { MAX_VOICE_FRAME_BYTES, VOICE_CLOSE, relayMessageSchema } from '@stream/voice/protocol'
import type { RelayMessage, VoiceEndReason } from '@stream/voice/protocol'
import type { VoiceAudio } from './voiceAudio'

/** How long the relay has to say `ended` after End before the browser closes the socket itself. */
const END_GRACE_MS = 5000
/** The ends that come after the persona's goodbye, and how long what is queued of it still plays (the relay waits 10
 *  seconds at most for the goodbye). */
const GOODBYE_REASONS: ReadonlySet<VoiceEndReason> = new Set(['session_limit', 'cost_limit', 'budget'])
const GOODBYE_DRAIN_MS = 10_000

export interface VoiceConnectionEvents {
  readonly onMessage: (message: RelayMessage) => void
  readonly onLevel: (level: number) => void
  /** The session is over on this side (once): the reason the relay gave, else why the browser closed it. */
  readonly onClosed: (reason: VoiceEndReason) => void
}

export interface VoiceConnection {
  readonly connect: () => void
  readonly end: () => void
  readonly release: () => void
}

function relayMessage(data: string): RelayMessage | null {
  try {
    const parsed = relayMessageSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function createVoiceConnection(url: string, audio: VoiceAudio, events: VoiceConnectionEvents): VoiceConnection {
  const held: { socket: WebSocket | null; mounted: boolean; closed: boolean; reason: VoiceEndReason | null } = {
    socket: null, mounted: false, closed: false, reason: null,
  }
  const isOpen = () => held.socket !== null && held.socket.readyState === WebSocket.OPEN

  const finish = (reason: VoiceEndReason) => {
    if (held.closed) return
    held.closed = true
    const ended = held.reason ?? reason
    if (held.socket !== null && held.socket.readyState <= WebSocket.OPEN) held.socket.close(VOICE_CLOSE.normal)
    audio.close(GOODBYE_REASONS.has(ended) ? GOODBYE_DRAIN_MS : 0)
      .catch((error: unknown) => { console.warn('Voice session: releasing the audio failed', error) })
    events.onClosed(ended)
  }

  const sendFrame = (pcm: ArrayBuffer) => {
    if (isOpen() && pcm.byteLength <= MAX_VOICE_FRAME_BYTES) held.socket?.send(pcm)
  }

  const onText = (data: string) => {
    const message = relayMessage(data)
    if (message === null) return
    if (message.type === 'ready') audio.startCapture(sendFrame, events.onLevel)
    if (message.type === 'interrupted') audio.flush()
    events.onMessage(message)
    if (message.type === 'ended') {
      held.reason = message.reason
      finish(message.reason)
    }
  }

  const end = () => {
    if (held.closed) return
    if (!isOpen()) {
      finish('ended_by_person')
      return
    }
    held.socket?.send(JSON.stringify({ type: 'end' }))
    globalThis.setTimeout(() => finish('ended_by_person'), END_GRACE_MS)
  }

  return {
    connect: () => {
      held.mounted = true
      if (held.socket !== null || held.closed) return
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      socket.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (event.data instanceof ArrayBuffer) audio.play(event.data)
        else if (typeof event.data === 'string') onText(event.data)
      })
      socket.addEventListener('close', () => finish('disconnected'))
      held.socket = socket
    },
    end,
    release: () => {
      held.mounted = false
      globalThis.setTimeout(() => { if (!held.mounted) end() }, 0)
    },
  }
}
