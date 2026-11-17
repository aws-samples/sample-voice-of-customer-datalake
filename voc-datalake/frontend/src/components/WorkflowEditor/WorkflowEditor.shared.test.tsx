/**
 * @fileoverview The shared-flow guard in the editor (7.52.00 C2; the server's `PUT /workflows/<id>` 409 `shared_flow`):
 * a flow other automations run names them in a banner, its Save asks first and then sends `confirm_shared: true`;
 * a flow that looked unshared but whose save is refused as shared (someone started using it meanwhile) asks too; the
 * automation whose page hosts the editor needs no confirmation; a flow nobody uses saves as before.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { fileInput, jsonFile, withPrdStep, workflowView } from '@test/workflowFixtures'
import { ApiError } from '../../lib/errors'
import { emptyDefinition } from './model-fixtures'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { WorkflowEditor } = await import('./WorkflowEditor')

const STORED: WorkflowDefinition = emptyDefinition('Research flow')
const EDITED: WorkflowDefinition = withPrdStep(emptyDefinition('Research flow'))
const BUG_FIXER = { agent_id: 'ag_0123456789ab', name: 'Bug fixer', kind: 'agents', connection: null, language: null }
const SHARED = { automations: [BUG_FIXER], flows: [] }
const NOBODY = { automations: [], flows: [] }

const view = (revision: number, definition: WorkflowDefinition, usedBy: unknown) => workflowView(revision, definition, { used_by: usedBy })

function routes(extra: Record<string, Handler>, usedBy: unknown = SHARED) {
  route({
    'GET /workflows/wf_1': () => view(3, STORED, usedBy),
    'POST /workflows/validate': () => ({ valid: true, errors: [] }),
    ...extra,
  })
}

async function editAndSave(agentId?: string) {
  const { container } = renderWithQueryClient(<WorkflowEditor workflowId="wf_1" canEdit agentId={agentId} />)
  await screen.findByRole('button', { name: 'Export' })
  await userEvent.upload(fileInput(container), jsonFile(JSON.stringify(EDITED)))
  await screen.findByText('Unsaved changes')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
}

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
})

describe('a shared flow', () => {
  it('names the automations that run it, asks before saving, then saves it for all of them', async () => {
    const save = vi.fn((_body: unknown) => view(4, EDITED, SHARED))
    routes({ 'PUT /workflows/wf_1': save })
    await editAndSave()
    expect(screen.getByRole('note')).toHaveTextContent('Used by 1 automation: Bug fixer. Saving changes it from its next run.')
    const dialog = await screen.findByRole('dialog', { name: 'Save a shared flow?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save for all of them' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ definition: EDITED, expected_revision: 3, confirm_shared: true }))
  })

  it('asks when the server refuses a save as shared, and saves confirmed once asked', async () => {
    const save = vi.fn((body: unknown) => {
      if (typeof body === 'object' && body !== null && 'confirm_shared' in body) return view(4, EDITED, SHARED)
      throw new ApiError(409, 'other automations run this flow', 'shared_flow')
    })
    routes({ 'PUT /workflows/wf_1': save }, NOBODY)
    await editAndSave()
    const dialog = await screen.findByRole('dialog', { name: 'Save a shared flow?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save for all of them' }))
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ definition: EDITED, expected_revision: 3, confirm_shared: true }))
  })

  it('needs no confirmation on the page of the one automation that runs it, and names it', async () => {
    const save = vi.fn((_body: unknown) => view(4, EDITED, SHARED))
    routes({ 'PUT /workflows/wf_1': save })
    await editAndSave(BUG_FIXER.agent_id)
    await waitFor(() => expect(save).toHaveBeenCalledWith({ definition: EDITED, expected_revision: 3, agent_id: BUG_FIXER.agent_id }))
    expect(screen.queryByRole('dialog', { name: 'Save a shared flow?' })).not.toBeInTheDocument()
  })

  it('saves a flow nobody else runs as before, without asking', async () => {
    const save = vi.fn((_body: unknown) => view(4, EDITED, NOBODY))
    routes({ 'PUT /workflows/wf_1': save }, NOBODY)
    await editAndSave()
    await waitFor(() => expect(save).toHaveBeenCalledWith({ definition: EDITED, expected_revision: 3 }))
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })
})
