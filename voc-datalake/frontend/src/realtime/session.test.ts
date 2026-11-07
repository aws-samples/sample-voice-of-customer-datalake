import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { agentsKeys } from '../api/agentsApi'
import { plansKeys } from '../api/plansApi'
import { useAuthStore } from '../store/authStore'
import type { RealtimeTransport } from './connection'
import { deliverNotice, isRealtimeLive, setRealtimeLive } from './hub'
import { watchRealtimeSession } from './session'

const endpoints = vi.hoisted((): { value: { httpDns: string; realtimeDns: string } | null } => ({ value: null }))
vi.mock('../runtimeConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtimeConfig')>(),
  getRealtimeEndpoints: () => endpoints.value,
}))

const SUB = '0a1b2c3d-1111-4222-8333-444455556666'

function fakeTransport() {
  const channels: string[] = []
  const transport: RealtimeTransport = {
    subscribe: (channel) => {
      channels.push(channel)
      return Promise.resolve(vi.fn())
    },
    onConnectionChange: () => vi.fn(),
  }
  return { transport, channels }
}

function signIn(sub: string) {
  useAuthStore.setState({ user: { username: 'u', email: 'u@example.com', groups: [], sub }, isAuthenticated: true })
}

beforeEach(() => {
  vi.useFakeTimers()
  setRealtimeLive(false)
  endpoints.value = { httpDns: 'a.appsync-api.us-east-1.amazonaws.com', realtimeDns: 'a.appsync-realtime-api.us-east-1.amazonaws.com' }
  useAuthStore.setState({ user: null, isAuthenticated: false })
})
afterEach(() => { vi.useRealTimers() })

describe('watchRealtimeSession', () => {
  it('subscribes on sign-in and closes on sign-out', async () => {
    const fake = fakeTransport()
    const unbind = watchRealtimeSession(new QueryClient(), fake.transport)
    signIn(SUB)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.channels).toHaveLength(3)
    expect(isRealtimeLive()).toBe(true)
    useAuthStore.setState({ user: null, isAuthenticated: false })
    expect(isRealtimeLive()).toBe(false)
    unbind()
  })

  it('does nothing without an Event API (the dev mock, an older deployment)', async () => {
    endpoints.value = null
    const fake = fakeTransport()
    const unbind = watchRealtimeSession(new QueryClient(), fake.transport)
    signIn(SUB)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.channels).toStrictEqual([])
    expect(isRealtimeLive()).toBe(false)
    unbind()
  })

  it('refreshes the run and plan queries a notice names', () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const unbind = watchRealtimeSession(queryClient, fakeTransport().transport)
    deliverNotice({ type: 'run', agent_id: 'ag_1', run_id: 'run_1', status: 'completed' })
    deliverNotice({ type: 'plan', plan_id: 'pl_1', change: 'step_finished' })
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
    expect(keys).toStrictEqual([
      agentsKeys.run('ag_1', 'run_1'), agentsKeys.runs('ag_1'), agentsKeys.detail('ag_1'), agentsKeys.list(),
      plansKeys.detail('pl_1'), plansKeys.list(),
    ])
    unbind()
  })
})
