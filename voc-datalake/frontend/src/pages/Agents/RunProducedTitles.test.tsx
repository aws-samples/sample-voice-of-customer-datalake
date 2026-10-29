/**
 * @fileoverview "What it produced" names each document by its title and version, and the
 * project by its name even when the project list does not know it yet.
 *
 * 5.35.02 live: three identical "PR/FAQ ready · in a project" lines for PR/FAQ v1, v2 and v3 —
 * the agent created the project after the cached project list was read.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { wfNode, workflowView } from '@test/workflowFixtures'
import { scoutAgent } from '@test/agentFixtures'
import { versionedTitle } from './useRunProjects'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { RunsTab } = await import('./RunsTab')

const RUN = {
  run_id: 'run_1', agent_id: 'ag_1', status: 'completed', trigger: 'manual', started_at: '2026-10-25T19:44:55Z',
  finished_at: '2026-10-25T20:00:12Z', project_id: 'p_9', current_node_id: null, model_calls: 17, error: null,
  workflow_id: 'wf_1', workflow_revision: 1,
}
const artifact = (seq: number, documentId: string) => ({
  seq, at: '2026-10-25T19:53:10Z', kind: 'artifact', node_id: 'prfaq', summary: 'PR/FAQ ready',
  ref: { project_id: 'p_9', document_id: documentId },
})
const doc = (id: string, version: number) => ({
  document_id: id, document_type: 'prfaq', title: `Refunds take weeks (v${String(version)})`, version, content: '',
  created_at: '2026-10-25T19:53:10Z',
})
const DETAILS = {
  details: [{
    project: { project_id: 'p_9', name: 'Example Air support', description: '', status: 'active',
      created_at: '2026-10-25T19:46:10Z', updated_at: '2026-10-25T19:46:10Z', persona_count: 3, document_count: 3 },
    documents: [doc('d_1', 1), doc('d_2', 2), doc('d_3', 3)],
  }],
}

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
  route({
    'GET /agents/ag_1/runs': () => ({ items: [RUN] }),
    'GET /agents/ag_1/runs/run_1': () => RUN,
    'GET /agents/ag_1/runs/run_1/events?after=0': () => ({ items: [artifact(1, 'd_1'), artifact(2, 'd_2'), artifact(3, 'd_3')] }),
    'GET /workflows/wf_1': () => workflowView(1, { schema: 'voc-workflow/1', name: 'Flow', nodes: [wfNode('prfaq', 'write_prfaq', 'Write')], edges: [], loops: [] }),
    // The cached list predates the project the run created.
    'GET /projects': () => ({ projects: [] }),
    'GET /projects?ids=p_9': () => DETAILS,
  })
})

describe('What it produced', () => {
  it('names every PR/FAQ version by its title and the project by its name', async () => {
    renderWithQueryClient(<TestRouter><RunsTab agent={scoutAgent()} isAdmin /></TestRouter>)
    const summary = await screen.findByRole('region', { name: 'What happened' })

    for (const version of [1, 2, 3]) {
      expect(await within(summary).findByRole('link', { name: `PR/FAQ ready: Refunds take weeks (v${String(version)})` }))
        .toBeInTheDocument()
    }
    expect(within(summary).getAllByText('· in Example Air support')).toHaveLength(3)
    expect(within(summary).queryByText(/in a project/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Example Air support' })).toBeInTheDocument()
  })
})

describe('versionedTitle', () => {
  it.each([
    [{ title: 'Refunds (v2)', version: 2 }, 'Refunds (v2)'],
    [{ title: 'Refunds', version: 2 }, 'Refunds (v2)'],
    [{ title: ' Refunds ', version: undefined }, 'Refunds'],
    [{ title: '  ', version: 3 }, ''],
  ])('%o reads %s', (document, expected) => {
    expect(versionedTitle(document)).toBe(expected)
  })
})
