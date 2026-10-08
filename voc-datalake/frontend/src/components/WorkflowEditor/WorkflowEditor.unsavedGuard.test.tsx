/**
 * @fileoverview The workflow editor's hand-building edits (workflow settings
 * panel, palette adds) under the shared unsaved-changes guard (E2E F6), in a
 * DATA router so `useBlocker` is live: leaving asks first, the dialog's Save
 * creates the revision from the hand-edited draft, Cancel keeps the draft, and
 * the built-in template (Save as only) offers Discard but not Save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import { resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { emptyDefinition } from './model-fixtures'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { WorkflowEditor } = await import('./WorkflowEditor')

const STORED = emptyDefinition('Research flow')

function renderInRouter(handlers: Record<string, Handler>, client = createTestQueryClient()) {
  route({ 'POST /workflows/validate': () => ({ valid: true, errors: [] }), ...handlers })
  const router = createMemoryRouter(
    [
      { path: '/workflows', element: <p>Workflow list page</p> },
      {
        path: '/workflows/:id',
        element: (
          <>
            <Link to="/workflows">Back to workflows</Link>
            <WorkflowEditor workflowId="wf_1" canEdit />
          </>
        ),
      },
    ],
    { initialEntries: ['/workflows/wf_1'] },
  )
  renderWithQueryClient(<RouterProvider router={router} />, client)
  return router
}

const panel = () => screen.getByRole('complementary', { name: 'Step settings' })
const guardDialog = () => screen.queryByRole('dialog', { name: 'Unsaved changes' })
const dialogButton = (name: string) =>
  within(screen.getByRole('dialog', { name: 'Unsaved changes' })).getByRole('button', { name })

/** Rename the workflow in the settings panel shown while nothing is selected. */
async function renameInSettingsPanel(name: string) {
  await screen.findByText('Revision 3')
  const field = within(panel()).getByLabelText('Workflow name')
  await userEvent.clear(field)
  await userEvent.type(field, name)
  await screen.findByText('Unsaved changes')
}

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
})

describe('WorkflowEditor — unsaved-changes guard over hand-built edits', () => {
  it('asks before leaving a renamed workflow; Cancel keeps the draft', async () => {
    const router = renderInRouter({ 'GET /workflows/wf_1': () => workflowView(3, STORED) })
    await renameInSettingsPanel('Renamed flow')
    await userEvent.click(screen.getByRole('link', { name: 'Back to workflows' }))
    expect(guardDialog()).toBeInTheDocument()
    await userEvent.click(dialogButton('Cancel'))
    expect(guardDialog()).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/workflows/wf_1')
    expect(within(panel()).getByLabelText('Workflow name')).toHaveValue('Renamed flow')
  })

  it("the dialog's Save creates a revision from the hand-edited draft, then leaves", async () => {
    const stored = { current: workflowView(3, STORED) }
    const save = vi.fn((body: unknown) => {
      stored.current = workflowView(4, { ...STORED, name: 'Renamed flow' })
      return { ...stored.current, echoed: body }
    })
    renderInRouter({ 'GET /workflows/wf_1': () => stored.current, 'PUT /workflows/wf_1': save })
    await renameInSettingsPanel('Renamed flow')
    await userEvent.click(screen.getByRole('link', { name: 'Back to workflows' }))
    await userEvent.click(dialogButton('Save'))
    expect(await screen.findByText('Workflow list page')).toBeInTheDocument()
    expect(save).toHaveBeenCalledWith({ definition: { ...STORED, name: 'Renamed flow' }, expected_revision: 3 })
  })

  it('a palette add on the built-in template offers Discard, not Save', async () => {
    const save = vi.fn()
    renderInRouter({ 'GET /workflows/wf_1': () => workflowView(3, STORED, { builtin: true }), 'PUT /workflows/wf_1': save })
    await screen.findByText('Revision 3')
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Steps' })).getByRole('button', { name: 'Write PRD' }))
    await screen.findByText('Unsaved changes')
    await userEvent.click(screen.getByRole('link', { name: 'Back to workflows' }))
    await screen.findByRole('dialog', { name: 'Unsaved changes' })
    expect(dialogButton('Save')).toBeDisabled()
    await userEvent.click(dialogButton('Discard'))
    expect(await screen.findByText('Workflow list page')).toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })
})

describe('WorkflowEditor — the shared Cancel-keeps-the-draft contract (3.00.00 R2)', () => {
  it('keeps the rename and stays guarded when the workflow refetches while the dialog is open', async () => {
    const client = createTestQueryClient()
    const mounted: { router?: ReturnType<typeof renderInRouter> } = {}
    await expectCancelKeepsDraftGuarded({
      mount: async () => {
        mounted.router = renderInRouter({ 'GET /workflows/wf_1': () => workflowView(3, STORED) }, client)
        await screen.findByText('Revision 3')
      },
      edit: async () => { await renameInSettingsPanel('Renamed flow') },
      expectDraft: () => expect(within(panel()).getByLabelText('Workflow name')).toHaveValue('Renamed flow'),
      leave: async (user) => { await user.click(screen.getByRole('link', { name: 'Back to workflows' })) },
      expectStayed: () => expect(mounted.router?.state.location.pathname).toBe('/workflows/wf_1'),
      expectLeft: async () => { expect(await screen.findByText('Workflow list page')).toBeInTheDocument() },
      // A background refetch of the same revision (window focus, another tab's list refresh).
      whileDialogOpen: async () => { await client.invalidateQueries() },
    })
  })
})
