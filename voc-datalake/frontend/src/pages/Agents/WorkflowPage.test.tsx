/**
 * @fileoverview Starting and opening workflows from the library (live browser
 * test: the library only listed and archived). "New workflow" asks for a name
 * (and an optional description) and only on submit creates a valid Start → End
 * workflow, opened on `/agents/workflows/:workflowId`; each row
 * opens its workflow there; on that page Save as opens the copy without the
 * unsaved-changes guard getting in the way (the draft lives in the copy). Rename
 * (not on the built-in) saves the trimmed name and says why when it is refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { adminFlag, resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { workflowDefinitionSchema } from '../../api/workflowsApi'
import { emptyDefinition } from '../../components/WorkflowEditor/model-fixtures'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { WorkflowLibrary } = await import('./WorkflowLibrary')
const { default: WorkflowPage } = await import('./WorkflowPage')

const STORED = workflowView(2, emptyDefinition('Research flow'))
const SUMMARY = { workflow_id: 'wf_1', name: 'Research flow', revision: 2 }

function renderAt(entry: string, extra: Record<string, Handler> = {}) {
  route({
    'GET /workflows': () => ({ items: [SUMMARY] }),
    'GET /workflows/wf_1': () => STORED,
    'POST /workflows/validate': () => ({ valid: true, errors: [] }),
    ...extra,
  })
  const router = createMemoryRouter(
    [
      { path: '/agents', element: <WorkflowLibrary /> },
      { path: '/agents/workflows/:workflowId', element: <WorkflowPage /> },
    ],
    { initialEntries: [entry] },
  )
  renderWithQueryClient(<RouterProvider router={router} />)
  return router
}

const isDefinitionBody = (value: unknown): value is { definition: unknown } =>
  typeof value === 'object' && value !== null && 'definition' in value

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('Workflow library — New workflow and Open', () => {
  it('asks for a name first, then creates a valid Start → End workflow with it and opens it', async () => {
    const created = workflowView(1, emptyDefinition('Churn watch'), { workflow_id: 'wf_new' })
    const create = vi.fn((_body: unknown) => created)
    const router = renderAt('/agents', { 'POST /workflows': create, 'GET /workflows/wf_new': () => created })
    await userEvent.click(await screen.findByRole('button', { name: 'New workflow' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a workflow' })
    await userEvent.type(within(dialog).getByLabelText('Workflow name'), '  Churn watch ')
    await userEvent.type(within(dialog).getByLabelText('Description'), 'Weekly churn signals')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create workflow' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/workflows/wf_new'))
    const body: unknown = create.mock.calls[0]?.[0]
    const parsed = workflowDefinitionSchema.safeParse(isDefinitionBody(body) ? body.definition : null)
    expect(parsed.data?.nodes.map((n) => n.type)).toStrictEqual(['start', 'end'])
    expect(parsed.data).toMatchObject({ name: 'Churn watch', description: 'Weekly churn signals' })
  })

  it('creates nothing until the dialog is submitted: Create is off without a name, and Cancel closes it', async () => {
    const create = vi.fn((_body: unknown) => STORED)
    renderAt('/agents', { 'POST /workflows': create })
    await userEvent.click(await screen.findByRole('button', { name: 'New workflow' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a workflow' })
    expect(within(dialog).getByRole('button', { name: 'Create workflow' })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
  })

  it('opens a workflow from its row', async () => {
    const router = renderAt('/agents')
    await userEvent.click(await screen.findByRole('link', { name: 'Open Research flow' }))
    expect(await screen.findByRole('button', { name: 'Export' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/agents/workflows/wf_1')
  })
})

describe('Workflow page', () => {
  it('saves an edited workflow as a copy and opens the copy, without the unsaved-changes prompt', async () => {
    const copy = workflowView(1, emptyDefinition('Research flow (copy)'), { workflow_id: 'wf_2' })
    const router = renderAt('/agents/workflows/wf_1', { 'POST /workflows': () => copy, 'GET /workflows/wf_2': () => copy })
    await screen.findByRole('button', { name: 'Export' })
    await userEvent.type(screen.getByLabelText('Workflow name'), ' v2')
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save as…' }))
    expect(await screen.findByText('Saved as “Research flow (copy)”.')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/agents/workflows/wf_2')
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument()
  })
})

const BUILTIN = { workflow_id: 'wf_default', name: 'Reviews → Prototype', revision: 1, builtin: true }
const RESEARCH = { workflow_id: 'wf_1', name: 'Research flow', revision: 2 }

const renderLibrary = (list: () => unknown, extra: Record<string, Handler> = {}) => renderAt('/agents', { 'GET /workflows': list, ...extra })

const openRename = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Rename Research flow' }))
  return screen.findByRole('dialog')
}

describe('Workflow library — Rename', () => {
  it('renames a workflow to the trimmed name and shows it in the list', async () => {
    const items = { current: [BUILTIN, RESEARCH] }
    const rename = vi.fn((_body: unknown) => {
      items.current = [BUILTIN, { ...RESEARCH, name: 'Weekly research', revision: 3 }]
      return workflowView(3, emptyDefinition('Weekly research'))
    })
    renderLibrary(() => ({ items: items.current }), { 'POST /workflows/wf_1/rename': rename })
    const dialog = await openRename()
    const field = within(dialog).getByLabelText('Workflow name')
    expect(field).toHaveValue('Research flow')
    await userEvent.clear(field)
    await userEvent.type(field, '  Weekly research  ')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(rename).toHaveBeenCalledWith({ name: 'Weekly research' }))
    expect(await screen.findByText('Weekly research')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers no Rename on the built-in template', async () => {
    renderLibrary(() => ({ items: [BUILTIN, RESEARCH] }))
    await screen.findByRole('button', { name: 'Rename Research flow' })
    expect(screen.queryByRole('button', { name: 'Rename Reviews → Prototype' })).not.toBeInTheDocument()
  })

  it('will not save an empty name', async () => {
    const rename = vi.fn()
    renderLibrary(() => ({ items: [RESEARCH] }), { 'POST /workflows/wf_1/rename': rename })
    const dialog = await openRename()
    await userEvent.clear(within(dialog).getByLabelText('Workflow name'))
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeDisabled()
    expect(rename).not.toHaveBeenCalled()
  })

  it.each([
    ['409', 'Someone changed this workflow meanwhile, or it is the built-in one. Reload and try again.'],
    ['500', 'The workflow couldn’t be renamed.'],
  ])('says so in the dialog when the API answers %s, and keeps it open', async (status, message) => {
    renderLibrary(() => ({ items: [RESEARCH] }), {
      'POST /workflows/wf_1/rename': () => { throw new Error(`API Error: ${status}`) },
    })
    const dialog = await openRename()
    await userEvent.type(within(dialog).getByLabelText('Workflow name'), ' v2')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('cancelling leaves the name as it was', async () => {
    const rename = vi.fn()
    renderLibrary(() => ({ items: [RESEARCH] }), { 'POST /workflows/wf_1/rename': rename })
    const dialog = await openRename()
    await userEvent.type(within(dialog).getByLabelText('Workflow name'), ' changed')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(rename).not.toHaveBeenCalled()
    expect(screen.getByText('Research flow')).toBeInTheDocument()
  })
})
