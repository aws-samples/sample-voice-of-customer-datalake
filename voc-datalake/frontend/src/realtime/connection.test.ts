import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RETRY_DELAYS_MS, startRealtime, stopRealtime, type RealtimeTransport } from './connection'
import { isRealtimeLive, onRealtimeNotice, onRealtimeReconnect, setRealtimeLive } from './hub'

interface FakeChannel { channel: string; onData: (data: unknown) => void; onError: (error: unknown) => void; closed: boolean }

function fakeTransport(options: { failTimes?: number } = {}) {
  const channels: FakeChannel[] = []
  const connection: { listener: ((connected: boolean) => void) | null } = { listener: null }
  const counter = { failures: options.failTimes ?? 0, calls: 0 }
  const transport: RealtimeTransport = {
    subscribe: (channel, onData, onError) => {
      counter.calls += 1
      if (counter.failures > 0) {
        counter.failures -= 1
        return Promise.reject(new Error('socket closed'))
      }
      const entry: FakeChannel = { channel, onData, onError, closed: false }
      channels.push(entry)
      return Promise.resolve(() => { entry.closed = true })
    },
    onConnectionChange: (listener) => {
      connection.listener = listener
      return () => { connection.listener = null }
    },
  }
  return { transport, channels, connection, counter }
}

const SUB = '0a1b2c3d-1111-4222-8333-444455556666'

beforeEach(() => {
  vi.useFakeTimers()
  setRealtimeLive(false)
})
afterEach(() => {
  stopRealtime()
  vi.useRealTimers()
})

describe('the realtime connection', () => {
  it('subscribes exactly the caller\'s own three channels, then is live', async () => {
    const fake = fakeTransport()
    startRealtime(SUB, fake.transport)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.channels.map((c) => c.channel)).toStrictEqual([`/jobs/${SUB}`, `/chat/${SUB}`, `/runs/${SUB}`])
    expect(isRealtimeLive()).toBe(true)
  })

  it('delivers only valid notices', async () => {
    const fake = fakeTransport()
    const heard = vi.fn()
    const stop = onRealtimeNotice(heard)
    startRealtime(SUB, fake.transport)
    await vi.advanceTimersByTimeAsync(0)
    fake.channels[0]?.onData({ event: JSON.stringify({ type: 'job', job_id: 'job_1', status: 'failed' }) })
    fake.channels[0]?.onData({ event: '{"type":"job"}' })
    expect(heard.mock.calls).toStrictEqual([[{ type: 'job', job_id: 'job_1', status: 'failed' }]])
    stop()
  })

  it('retries a failed connect with backoff and announces the connect', async () => {
    const fake = fakeTransport({ failTimes: 3 })
    const reconnected = vi.fn()
    const stop = onRealtimeReconnect(reconnected)
    startRealtime(SUB, fake.transport)
    await vi.advanceTimersByTimeAsync(0)
    expect(isRealtimeLive()).toBe(false)
    expect(fake.channels.every((c) => c.closed)).toBe(true)
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0])
    expect(isRealtimeLive()).toBe(true)
    expect(reconnected).toHaveBeenCalledExactlyOnceWith()
    stop()
  })

  it('a channel error closes the session and reconnects', async () => {
    const fake = fakeTransport()
    startRealtime(SUB, fake.transport)
    await vi.advanceTimersByTimeAsync(0)
    fake.channels[1]?.onError(new Error('dropped'))
    fake.channels[2]?.onError(new Error('dropped'))
    expect(isRealtimeLive()).toBe(false)
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0])
    expect(fake.counter.calls).toBe(6)
    expect(isRealtimeLive()).toBe(true)
  })

  it('follows the socket\'s own drop and reconnect', async () => {
    const fake = fakeTransport()
    startRealtime(SUB, fake.transport)
    await vi.advanceTimersByTimeAsync(0)
    fake.connection.listener?.(false)
    expect(isRealtimeLive()).toBe(false)
    fake.connection.listener?.(true)
    expect(isRealtimeLive()).toBe(true)
  })

  it('stop closes every channel and goes back to polling', async () => {
    const fake = fakeTransport()
    startRealtime(SUB, fake.transport)
    await vi.advanceTimersByTimeAsync(0)
    stopRealtime()
    expect(fake.channels.every((c) => c.closed)).toBe(true)
    expect(isRealtimeLive()).toBe(false)
    expect(fake.connection.listener).toBeNull()
  })
})
