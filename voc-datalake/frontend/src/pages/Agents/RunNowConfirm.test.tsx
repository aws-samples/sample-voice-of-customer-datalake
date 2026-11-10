/**
 * @fileoverview The Run now confirmation names the workflow by its name: a
 * placeholder while the workflow loads, the id only when it cannot be read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { normalizeAgent } from '../../api/agentsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { RunNowConfirm } = await import('./RunNowConfirm')

/** Through the real boundary normaliser: every omitted field takes its lenient default. */
const AGENT = normalizeAgent({ agent_id: 'ag_1', name: 'Scout', workflow_id: 'wf_1' })

const FLOW = workflowView(1, { schema: 'voc-workflow/1', name: 'Flow', nodes: [], edges: [], loops: [] })

function renderConfirm(): void {
  if (AGENT === null) throw new Error('fixture agent did not normalise')
  renderWithQueryClient(<RunNowConfirm agent={AGENT} starting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />)
}

describe('RunNowConfirm', () => {
  beforeEach(() => { resetFetchApi() })

  it('names the workflow once it loads, never its id', async () => {
    routeFetchApi({ 'GET /workflows/wf_1': () => FLOW })
    renderConfirm()
    expect(screen.getByText('…')).toBeInTheDocument()
    expect(await screen.findByText('Flow')).toBeInTheDocument()
    expect(screen.queryByText('wf_1')).not.toBeInTheDocument()
  })

  it('falls back to the id when the workflow cannot be read', async () => {
    routeFetchApi({}, { missStatus: 500 })
    renderConfirm()
    expect(await screen.findByText('wf_1')).toBeInTheDocument()
  })
})
