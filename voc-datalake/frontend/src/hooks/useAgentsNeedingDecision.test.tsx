/**
 * @fileoverview The sidebar's "needs a decision" count: agents whose last run
 * stopped for a person, read from `/agents` only when enabled, and the pill it
 * puts on "Autonomous agents".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workflow } from 'lucide-react'
import { createTestQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { Sidebar } from '../components/Layout/SidebarComponents'
import type { ReactNode } from 'react'

vi.mock('../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { useAgentsNeedingDecision } = await import('./useAgentsNeedingDecision')

const agent = (id: string, lastRunStatus: string | null) => ({ agent_id: id, name: id, stats: { last_run_status: lastRunStatus } })

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
}

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({ 'GET /agents': () => ({ items: [agent('a', 'needs_human'), agent('b', 'completed'), agent('c', 'needs_human'), agent('d', null)] }) })
})

describe('useAgentsNeedingDecision', () => {
  it('counts the agents whose last run needs a decision', async () => {
    const { result } = renderHook(() => useAgentsNeedingDecision(true), { wrapper })
    await waitFor(() => expect(result.current).toBe(2))
  })

  it('reads nothing while disabled (signed out, or the menu item hidden)', () => {
    const { result } = renderHook(() => useAgentsNeedingDecision(false), { wrapper })
    expect(result.current).toBe(0)
    expect(fetchApi).not.toHaveBeenCalled()
  })
})

function renderSidebar(decisionCount: number) {
  render(
    <TestRouter>
      <Sidebar sidebarCollapsed={false} mobileMenuOpen={false} brandName="Example Air" brandLoading={false}
        visibleNavItems={[{ to: '/agents', icon: Workflow, labelKey: 'agents:nav.label', menuKey: 'agents' }]}
        urgentCount={0} decisionCount={decisionCount}
        onClose={() => undefined} onToggleCollapse={() => undefined} />
    </TestRouter>,
  )
}

describe('Sidebar — the count on "Autonomous agents"', () => {
  it('shows how many agents need a decision, named for screen readers', () => {
    renderSidebar(2)
    expect(screen.getByRole('link', { name: /Autonomous agents/ })).toHaveTextContent('2 2 agents need a decision')
  })

  it('shows no count at zero', () => {
    renderSidebar(0)
    expect(screen.getByRole('link', { name: 'Autonomous agents' })).toHaveTextContent(/^Autonomous agents$/)
  })
})
