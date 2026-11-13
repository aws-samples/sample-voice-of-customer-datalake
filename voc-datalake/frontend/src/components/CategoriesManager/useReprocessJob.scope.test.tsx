/**
 * Whose reprocess job the panel reaches (7.13.00): Administration's (`'deployment'` scope) never names the current
 * workspace, even inside one, so it stays the deployment's; beside a workspace's own categories (`'workspace'`, the
 * default) every call names the workspace, and the panel says it replays that workspace's reviews only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createTestQueryClient } from '../../test/query-client'
import { ACME } from '../../test/workspaceFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RequestScope } from '../../api/baseUrl'
import { ConfigScopeContext } from '../../workspace/configScope'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import ReprocessPanel from './ReprocessPanel'

const BASE = '/settings/categories/reprocess'
const QUEUED = {
  job_id: 'rp_0123456789ab', status: 'queued', mode: 'processed', days: 0, include_manual: false,
  scanned: 0, updated: 0, unchanged: 0, skipped_manual: 0, failed: 0, started_by: 'ada', created_at: 't0', updated_at: 't0',
}

function renderIn(scope: RequestScope, panel: ReactNode) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ConfigScopeContext.Provider value={scope}>{panel}</ConfigScopeContext.Provider>
    </QueryClientProvider>,
  )
}

/** The scope argument of every call to the reprocess routes (`'workspace'`: the current workspace). */
function scopesSent(): unknown[] {
  return fetchApi.mock.calls.filter(([endpoint]) => endpoint.startsWith(BASE)).map((call) => call[2])
}

async function startFromThePanel(): Promise<void> {
  const panel = await screen.findByRole('region', { name: 'Reprocess existing feedback' })
  await userEvent.click(within(panel).getByRole('button', { name: 'Start reprocessing' }))
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Start reprocessing' }))
}

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({ [`GET ${BASE}`]: () => ({ job: null }), [`POST ${BASE}`]: () => ({ job: QUEUED }) })
  act(() => setCurrentWorkspace(ACME))
})
afterEach(() => { setCurrentWorkspace(null) })

describe('the reprocess panel and its scope', () => {
  it("in Administration reads and starts the deployment's job, inside a workspace too", async () => {
    renderIn('deployment', <ReprocessPanel />)
    await startFromThePanel()
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(BASE, expect.objectContaining({ method: 'POST' }), 'deployment'))
    expect(scopesSent().length).toBeGreaterThan(1)
    expect(scopesSent().every((scope) => scope === 'deployment')).toBe(true)
    expect(screen.getByText(/After changing categories, re-categorise the reviews already stored/)).toBeInTheDocument()
  })

  it("beside a workspace's categories reads and starts that workspace's own job", async () => {
    renderIn('workspace', <ReprocessPanel inWorkspace />)
    await startFromThePanel()
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(BASE, expect.objectContaining({ method: 'POST' }), 'workspace'))
    expect(scopesSent().every((scope) => scope === 'workspace')).toBe(true)
    expect(screen.getByText(/Only this workspace's reviews are read and updated in place/)).toBeInTheDocument()
    // The source list is the deployment's (GET /settings/erasure): not offered, not even read, in a workspace.
    expect(fetchApi.mock.calls.some(([endpoint]) => endpoint === '/settings/erasure')).toBe(false)
  })
})
