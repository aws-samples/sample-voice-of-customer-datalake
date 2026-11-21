/**
 * Test doubles for a voice session (spec support): a WebSocket the test drives by hand (`FakeSocket.last`) and an
 * audio engine that records what it was asked to do. No real microphone, audio context or network.
 */
import { vi } from 'vitest'
import type { VoiceAudio } from '../pages/ProjectDetail/voice/voiceAudio'

export class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly opened: FakeSocket[] = []
  binaryType = 'blob'
  readyState = FakeSocket.CONNECTING
  readonly sent: Array<string | ArrayBuffer> = []
  readonly closes: number[] = []

  readonly url: string

  constructor(url: string) {
    super()
    this.url = url
    FakeSocket.opened.push(this)
  }

  static last(): FakeSocket {
    const socket = FakeSocket.opened.at(-1)
    if (socket === undefined) throw new Error('no socket was opened')
    return socket
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(code = 1000): void {
    this.closes.push(code)
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data) }))
  }

  /** The JSON control messages the browser sent. */
  controls(): unknown[] {
    return this.sent.filter((one): one is string => typeof one === 'string').map((one): unknown => JSON.parse(one))
  }
}

/** Install FakeSocket as the global WebSocket for one test (vi.unstubAllGlobals undoes it). */
export function stubWebSocket(): void {
  FakeSocket.opened.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
}

export interface FakeAudio extends VoiceAudio {
  readonly frames: { onFrame: ((pcm: ArrayBuffer) => void) | null; onLevel: ((level: number) => void) | null }
  readonly played: ArrayBuffer[]
  readonly flushes: { count: number }
  readonly closed: { count: number }
}

export function fakeAudio(): FakeAudio {
  const frames: FakeAudio['frames'] = { onFrame: null, onLevel: null }
  const played: ArrayBuffer[] = []
  const flushes = { count: 0 }
  const closed = { count: 0 }
  return {
    frames, played, flushes, closed,
    startCapture: (onFrame, onLevel) => { frames.onFrame = onFrame; frames.onLevel = onLevel },
    play: (pcm) => { played.push(pcm) },
    flush: () => { flushes.count += 1 },
    close: () => { closed.count += 1; return Promise.resolve() },
  }
}
