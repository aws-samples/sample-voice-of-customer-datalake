/**
 * The voice session's WebSocket: opened once per connection (the presigned URL is single-use), the persona's voice
 * played, the microphone started on `ready`, barge-in flushed, End asked of the relay and enforced after a grace,
 * a development double-mount kept alive and a real unmount ending it, the close reported once, and the persona's
 * goodbye left to play out after a time, cost cap or budget end (silenced at once after any other).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, fakeAudio, stubWebSocket } from '@test/voiceDoubles'
import { createVoiceConnection } from './voiceConnection'

const URL = 'wss://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/arn/ws?X-Amz-Signature=x'

/** A connection that has opened its socket (not yet open). */
function created() {
  const audio = fakeAudio()
  const events = { onMessage: vi.fn(), onLevel: vi.fn(), onClosed: vi.fn() }
  const connection = createVoiceConnection(URL, audio, events)
  connection.connect()
  return { audio, events, connection, socket: FakeSocket.last() }
}

function connected() {
  const made = created()
  made.socket.open()
  return made
}

beforeEach(() => {
  stubWebSocket()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createVoiceConnection', () => {
  it('opens one socket however often it connects, plays binary frames and starts the microphone on ready', () => {
    const { audio, events, connection, socket } = connected()
    connection.connect()
    socket.receive(new Uint8Array([1, 0]).buffer)
    socket.receive({ type: 'ready', voice_id: 'tiffany', session_seconds: 900, minutes_left: 100 })
    audio.frames.onFrame?.(new ArrayBuffer(2048))
    audio.frames.onFrame?.(new ArrayBuffer(40_000))
    expect([FakeSocket.opened.length, socket.binaryType, audio.played.length]).toStrictEqual([1, 'arraybuffer', 1])
    expect([socket.sent.length, events.onMessage.mock.calls.length]).toStrictEqual([1, 1])
  })

  it('flushes playback on interrupted, ignores what is not the protocol, and closes once with the relay\'s reason', () => {
    const { audio, events, socket } = connected()
    socket.receive({ type: 'interrupted' })
    socket.receive('not json')
    socket.receive({ type: 'mystery' })
    socket.receive({ type: 'ended', reason: 'budget' })
    socket.close()
    expect(audio.flushes.count).toBe(1)
    expect(events.onMessage.mock.calls.map(([message]: unknown[]) => message)).toStrictEqual([{ type: 'interrupted' }, { type: 'ended', reason: 'budget' }])
    expect([events.onClosed.mock.calls, audio.closed.count]).toStrictEqual([[['budget']], 1])
  })

  it('asks the relay to end, then closes it itself after the grace', () => {
    const { events, connection, socket } = connected()
    connection.end()
    expect(socket.controls()).toStrictEqual([{ type: 'end' }])
    expect(events.onClosed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect([events.onClosed.mock.calls, socket.closes]).toStrictEqual([[['ended_by_person']], [1000]])
  })

  it('survives a development double-mount, ends on a real unmount, and reports a dropped connection', () => {
    const first = connected()
    first.connection.release()
    first.connection.connect()
    vi.advanceTimersByTime(10)
    expect(first.socket.controls()).toStrictEqual([])
    first.connection.release()
    vi.advanceTimersByTime(10)
    expect(first.socket.controls()).toStrictEqual([{ type: 'end' }])
    const second = connected()
    second.socket.close()
    expect(second.events.onClosed.mock.calls).toStrictEqual([['disconnected']])
  })

  it('lets the queued goodbye play out after the time limit, the cost cap or the budget, and silences it after any other end', () => {
    const ends = ['session_limit', 'cost_limit', 'budget', 'ended_by_person', 'error', 'refused'].map((reason) => {
      const { audio, socket } = connected()
      socket.receive({ type: 'ended', reason })
      return audio.closed.drains
    })
    const dropped = connected()
    dropped.socket.close()
    expect([...ends, dropped.audio.closed.drains]).toStrictEqual([[10_000], [10_000], [10_000], [0], [0], [0], [0]])
  })

  it('ends at once when the socket never opened', () => {
    const { events, connection, socket } = created()
    connection.end()
    connection.end()
    expect([events.onClosed.mock.calls, socket.closes]).toStrictEqual([[['ended_by_person']], [1000]])
  })
})
