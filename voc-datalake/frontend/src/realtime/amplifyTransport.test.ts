import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const amplify = vi.hoisted(() => {
  const close = vi.fn(() => Promise.resolve())
  const subscribe = vi.fn()
  const connect = vi.fn(() => Promise.resolve({ subscribe, close }))
  const hub: { listener: ((capsule: unknown) => void) | null } = { listener: null }
  const stopHub = vi.fn()
  return { close, subscribe, connect, hub, stopHub }
})

vi.mock('aws-amplify/data', () => ({
  events: { connect: amplify.connect },
  CONNECTION_STATE_CHANGE: 'ConnectionStateChange',
}))
vi.mock('aws-amplify/utils', () => ({
  Hub: {
    listen: (_channel: string, listener: (capsule: unknown) => void) => {
      amplify.hub.listener = listener
      return amplify.stopHub
    },
  },
}))

import { amplifyTransport } from './amplifyTransport'

beforeEach(() => {
  vi.useFakeTimers()
  amplify.close.mockClear()
  amplify.connect.mockClear()
  amplify.subscribe.mockReset()
})
afterEach(() => { vi.useRealTimers() })

const stateChange = (connectionState: string) => ({ payload: { event: 'ConnectionStateChange', data: { connectionState } } })

describe('amplifyTransport', () => {
  it('connects the channel, subscribes and resolves once AppSync acknowledged it', async () => {
    amplify.subscribe.mockReturnValue({ ready: Promise.resolve({ subscriptionId: 's1' }) })
    const onData = vi.fn()
    const close = await amplifyTransport.subscribe('/jobs/sub-1', onData, vi.fn())
    expect(amplify.connect).toHaveBeenCalledWith('/jobs/sub-1')
    expect(amplify.subscribe.mock.calls[0]?.[0]).toMatchObject({ next: onData })
    close()
    expect(amplify.close).toHaveBeenCalledExactlyOnceWith()
  })

  it('fails (and closes the channel) when the subscribe is never acknowledged', async () => {
    amplify.subscribe.mockReturnValue({ ready: new Promise(vi.fn()) })
    const opened = amplifyTransport.subscribe('/jobs/sub-1', vi.fn(), vi.fn())
    const outcome = opened.then(() => 'resolved', (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(outcome).resolves.toBeInstanceOf(Error)
    expect(amplify.close).toHaveBeenCalledExactlyOnceWith()
  })

  it('reports the socket\'s connected and disrupted states, and ignores the rest', async () => {
    const listener = vi.fn()
    const stop = amplifyTransport.onConnectionChange(listener)
    await vi.advanceTimersByTimeAsync(0)
    amplify.hub.listener?.(stateChange('ConnectionDisrupted'))
    amplify.hub.listener?.(stateChange('Connecting'))
    amplify.hub.listener?.(stateChange('Connected'))
    amplify.hub.listener?.({ payload: { event: 'other' } })
    expect(listener.mock.calls).toStrictEqual([[false], [true]])
    stop()
    expect(amplify.stopHub).toHaveBeenCalledExactlyOnceWith()
  })
})
