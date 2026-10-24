/**
 * Live finding: the first switch to an agent tab showed an empty skeleton for more
 * than a second. The tabs' reads are now warmed — on idle after the agent loads and
 * on hover / focus of a tab — under the keys the tabs read, so the switch is cached.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { ReactNode } from 'react'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { useAgentTabPrefetch } = await import('./useAgentTabPrefetch')
const { agentsKeys } = await import('../../api/agentsApi')

const AGENT = { agent_id: 'ag_1', workflow_id: 'wf_1' }
const called = (endpoint: string) => fetchApi.mock.calls.some(([e]) => e === endpoint)

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({
    'GET /agents/ag_1/runs': () => ({ items: [] }),
    'GET /workflows/wf_1': () => ({}),
    'GET /workflows': () => ({ items: [] }),
  }, { missStatus: 403, ignoreQuery: true })
})

function setup() {
  const client = createTestQueryClient({ gcTime: 60_000 })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const hook = renderHook(() => useAgentTabPrefetch(AGENT, true), { wrapper })
  return { client, prefetch: hook.result.current }
}

describe('useAgentTabPrefetch', () => {
  it('warms the runs tab on hover, under the key the Runs tab reads', async () => {
    const { client, prefetch } = setup()
    await act(async () => { prefetch('runs') })
    await vi.waitFor(() => expect(client.getQueryData(agentsKeys.runs('ag_1'))).toBeDefined())
    expect(called('/workflows/wf_1')).toBe(true)
  })

  it('warms every tab once the browser is idle after the agent loads', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setup()
    expect(called('/agents/ag_1/runs')).toBe(false)
    await act(() => vi.advanceTimersByTimeAsync(500))
    await vi.waitFor(() => expect(called('/agents/ag_1/runs')).toBe(true))
    vi.useRealTimers()
  })
})
