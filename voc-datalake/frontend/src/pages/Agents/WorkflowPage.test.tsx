/**
 * @fileoverview Starting and opening workflows from the library (live browser
 * test: the library only listed and archived). "New workflow" asks for a name
 * (and an optional description) and only on submit creates a valid Start → End
 * workflow, opened on `/agents/workflows/:workflowId`; each row
 * opens its workflow there; on that page Save as opens the copy without the
 * unsaved-changes guard getting in the way (the draft lives in the copy). Rename
 * (not on the built-in) saves the trimmed name and says why when it is refused.
 * "Start from a template" (beside New engineering flow) lists the six default engineering flows with their
 * descriptions; choosing one opens the editor on an unsaved copy of the server's definition
 * (`GET /workflows/templates`) that nothing stores until Save, the library's own create, which opens the new flow.
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
import { findEngineeringTemplate } from '../../api/engineeringTemplates'
import templatesFile from '../../../../lambda/shared/engineering_flow_templates.json'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
vi.mock('../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))
const { engineeringModule: engineering } = await import('@test/engineeringModule')

const { WorkflowLibrary } = await import('./WorkflowLibrary')
const { default: WorkflowPage } = await import('./WorkflowPage')
const { default: WorkflowTemplatePage } = await import('./WorkflowTemplatePage')

const STORED = workflowView(2, emptyDefinition('Research flow'))
const SUMMARY = { workflow_id: 'wf_1', name: 'Research flow', revision: 2 }

function renderAt(entry: string, extra: Record<string, Handler> = {}) {
  route({
    'GET /workflows': () => ({ items: [SUMMARY] }),
    'GET /workflows/wf_1': () => STORED,
    'POST /workflows/validate': () => ({ valid: true, errors: [] }),
    'GET /workflows/templates': () => ({ items: templatesFile.templates, count: templatesFile.templates.length }),
    ...extra,
  })
  const router = createMemoryRouter(
    [
      { path: '/agents', element: <WorkflowLibrary /> },
      { path: '/agents/workflows/:workflowId', element: <WorkflowPage /> },
      { path: '/agents/workflows/templates/:templateId', element: <WorkflowTemplatePage /> },
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
  engineering.available = true
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

  it('New engineering flow creates a voc-workflow/2 Start → End flow, listed with its kind', async () => {
    const created = workflowView(1, { ...emptyDefinition('Bug hunt'), schema: 'voc-workflow/2' }, { workflow_id: 'wf_eng' })
    const create = vi.fn((_body: unknown) => created)
    const router = renderAt('/agents', {
      'GET /workflows': () => ({ items: [{ workflow_id: 'wf_eng', name: 'Old hunt', revision: 1, kind: 'engineering' }] }),
      'POST /workflows': create, 'GET /workflows/wf_eng': () => created,
    })
    expect(await screen.findByText('Engineering')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'New engineering flow' }))
    const dialog = await screen.findByRole('dialog', { name: 'New engineering flow' })
    await userEvent.type(within(dialog).getByLabelText('Workflow name'), 'Bug hunt')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create workflow' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/workflows/wf_eng'))
    const body: unknown = create.mock.calls[0]?.[0]
    const parsed = workflowDefinitionSchema.safeParse(isDefinitionBody(body) ? body.definition : null)
    expect(parsed.data?.schema).toBe('voc-workflow/2')
    expect(parsed.data?.nodes.map((n) => n.type)).toStrictEqual(['start', 'end'])
  })

  it('offers no New engineering flow without the engineering module, and still lists and opens a saved one', async () => {
    engineering.available = false
    renderAt('/agents', {
      'GET /workflows': () => ({ items: [{ workflow_id: 'wf_eng', name: 'Old hunt', revision: 1, kind: 'engineering' }] }),
    })
    expect(await screen.findByRole('link', { name: 'Open Old hunt' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New engineering flow' })).toBeNull()
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

  it('offers no Reset to template on a saved engineering flow (the template is an agents workflow)', async () => {
    const flow = workflowView(2, { ...emptyDefinition('Bug hunt'), schema: 'voc-workflow/2' })
    renderAt('/agents/workflows/wf_1', { 'GET /workflows/wf_1': () => flow })
    expect(await screen.findByRole('button', { name: 'Export' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset to template' })).toBeNull()
  })

  it('offers Reset to template on an agents workflow', async () => {
    renderAt('/agents/workflows/wf_1')
    expect(await screen.findByRole('button', { name: 'Reset to template' })).toBeInTheDocument()
  })

  it.each([true, false])('offers Save as on a saved engineering flow only with the module (%s), Save either way', async (available) => {
    engineering.available = available
    const flow = workflowView(2, { ...emptyDefinition('Bug hunt'), schema: 'voc-workflow/2' })
    renderAt('/agents/workflows/wf_1', { 'GET /workflows/wf_1': () => flow })
    expect(await screen.findByRole('button', { name: 'Export' })).toBeInTheDocument()
    expect([screen.queryByRole('button', { name: 'Save as…' }) !== null, screen.queryByRole('button', { name: 'Save' }) !== null])
      .toStrictEqual([available, true])
  })
})

const BUG_HUNT = findEngineeringTemplate('bug-hunt-and-fix')

describe('Workflow library — Start from a template', () => {
  it('lists the six default flows, each named and described', async () => {
    renderAt('/agents')
    await userEvent.click(await screen.findByRole('button', { name: 'Start from a template' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start from a template' })
    const links = within(dialog).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toStrictEqual([
      'understand-repository', 'issue-triage', 'bug-hunt-and-fix', 'feature', 'pr-review', 'self-improvement',
    ].map((id) => `/agents/workflows/templates/${id}`))
    expect(links.map((link) => (link.getAttribute('aria-describedby') ?? '') !== '')).not.toContain(false)
    expect(within(dialog).getByRole('link', { name: 'Bug hunt and fix' })).toHaveAccessibleDescription(
      'Hunts bugs in the packages it is given, fixes and reviews each one, runs the quality gate and stops at a draft pull request.')
  })

  it('closes the list with Escape', async () => {
    renderAt('/agents')
    await userEvent.click(await screen.findByRole('button', { name: 'Start from a template' }))
    await screen.findByRole('dialog', { name: 'Start from a template' })
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('is not offered without the engineering module', async () => {
    engineering.available = false
    renderAt('/agents')
    expect(await screen.findByRole('button', { name: 'New workflow' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start from a template' })).toBeNull()
  })

  it('opens the editor on an unsaved copy and stores nothing by opening it', async () => {
    const create = vi.fn()
    const router = renderAt('/agents', { 'POST /workflows': create })
    await userEvent.click(await screen.findByRole('button', { name: 'Start from a template' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('link', { name: 'Bug hunt and fix' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/workflows/templates/bug-hunt-and-fix'))
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()
    // A copy that is not stored has no Save as, Reset or History, and opening it created nothing.
    expect(screen.getByLabelText('Workflow name')).toHaveValue('Bug hunt and fix')
    expect([screen.queryByRole('button', { name: 'Save as…' }), screen.queryByRole('button', { name: 'Reset to template' }), create.mock.calls])
      .toStrictEqual([null, null, []])
  })

  it('Save creates the copy through the library create and opens the new flow, with no unsaved prompt', async () => {
    const created = workflowView(1, { ...BUG_HUNT?.definition, name: 'Bug hunt and fix' }, { workflow_id: 'wf_new', kind: 'engineering' })
    const create = vi.fn((_body: unknown) => created)
    const router = renderAt('/agents/workflows/templates/bug-hunt-and-fix', { 'POST /workflows': create, 'GET /workflows/wf_new': () => created })
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/workflows/wf_new'))
    const body: unknown = create.mock.calls[0]?.[0]
    const parsed = workflowDefinitionSchema.safeParse(isDefinitionBody(body) ? body.definition : null)
    expect([parsed.data?.schema, parsed.data?.nodes.map((node) => node.type)])
      .toStrictEqual(['voc-workflow/2', BUG_HUNT?.definition.nodes.map((node) => node.type)])
    expect(await screen.findByText('Saved as “Bug hunt and fix”.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument()
  })

  it('says why when the save is refused, and keeps the copy', async () => {
    renderAt('/agents/workflows/templates/pr-review', { 'POST /workflows': () => { throw new Error('API Error: 409') } })
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText("The workflow couldn't be saved.")).toBeInTheDocument()
    expect(screen.getByLabelText('Workflow name')).toHaveValue('PR review')
  })

  it('tells a person who is not an administrator that templates are for administrators, without asking the server', async () => {
    adminFlag.isAdmin = false
    const templates = vi.fn(() => ({ items: templatesFile.templates }))
    renderAt('/agents/workflows/templates/pr-review', { 'GET /workflows/templates': templates })
    expect(await screen.findByText(/Only administrators start engineering flows from a template/u)).toBeInTheDocument()
    expect([screen.queryByText(/This template isn't available here/u), templates.mock.calls]).toStrictEqual([null, []])
  })

  it('says the same when the server answers 403', async () => {
    renderAt('/agents/workflows/templates/pr-review', { 'GET /workflows/templates': () => { throw new Error('API Error: 403') } })
    expect(await screen.findByText(/Only administrators start engineering flows from a template/u)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to the workflow library' })).toBeInTheDocument()
  })

  it('the leave-page prompt saves an unsaved copy as Save does, and shows why when it cannot', async () => {
    const create = vi.fn((_body: unknown) => { throw new Error('API Error: 500') })
    const router = renderAt('/agents/workflows/templates/pr-review', { 'POST /workflows': create })
    await userEvent.click(await screen.findByRole('link', { name: 'All agents' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText("The workflow couldn't be saved.")).toBeInTheDocument()
    expect([create.mock.calls.length, router.state.location.pathname]).toStrictEqual([1, '/agents/workflows/templates/pr-review'])
  })

  it('the leave-page prompt creates the copy and then leaves', async () => {
    const created = workflowView(1, { ...BUG_HUNT?.definition, name: 'PR review' }, { workflow_id: 'wf_new', kind: 'engineering' })
    const create = vi.fn((_body: unknown) => created)
    const router = renderAt('/agents/workflows/templates/pr-review', { 'POST /workflows': create })
    await userEvent.click(await screen.findByRole('link', { name: 'All agents' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('says the read failed on a 500, not that the template is missing, and Try again opens the copy', async () => {
    const answers = { failing: true }
    renderAt('/agents/workflows/templates/pr-review', {
      'GET /workflows/templates': () => {
        if (answers.failing) throw new Error('API Error: 500')
        return { items: templatesFile.templates }
      },
    })
    expect(await screen.findByText("The template couldn't be loaded.")).toBeInTheDocument()
    expect(screen.queryByText(/This template isn't available here/u)).toBeNull()
    answers.failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByLabelText('Workflow name')).toHaveValue('PR review')
  })

  it('says the template is not available when the server does not offer it (404 where the module is off)', async () => {
    renderAt('/agents/workflows/templates/pr-review', { 'GET /workflows/templates': () => { throw new Error('API Error: 404') } })
    expect(await screen.findByText(/This template isn't available here/u)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it.each([['an unknown template', 'merge-everything', true], ['no engineering module', 'pr-review', false]])(
    'says the template is not available for %s, with the way back to the library', async (_case, templateId, available) => {
      engineering.available = available
      renderAt(`/agents/workflows/templates/${templateId}`)
      expect(await screen.findByText(/This template isn't available here/u)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Back to the workflow library' })).toHaveAttribute('href', '/agents?tab=workflows')
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
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

describe('a saved engineering flow\'s Start a run (its dialog: StartRunDialog.test.tsx)', () => {
  const engineeringFlow = workflowView(1, { ...emptyDefinition('Bug hunt'), schema: 'voc-workflow/2' }, { kind: 'engineering' })

  it('opens its dialog for an administrator, and Escape gives focus back to it', async () => {
    renderAt('/agents/workflows/wf_1', { 'GET /workflows/wf_1': () => engineeringFlow })
    const action = await screen.findByRole('button', { name: 'Start a run' })
    await userEvent.click(action)
    expect(await screen.findByRole('dialog', { name: 'Start a run of Bug hunt' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(action).toHaveFocus())
  })

  it('is off while the flow has unsaved changes, saying to save it first, and on again once they are gone', async () => {
    renderAt('/agents/workflows/wf_1', { 'GET /workflows/wf_1': () => engineeringFlow })
    const action = await screen.findByRole('button', { name: 'Start a run' })
    await screen.findByRole('button', { name: 'Export' })
    const field = within(screen.getByRole('complementary', { name: 'Step settings' })).getByLabelText('Workflow name')
    await userEvent.type(field, ' v2')
    await screen.findByText('Unsaved changes')
    expect(action).toBeDisabled()
    expect(action).toHaveAccessibleDescription('Save the flow first: a run uses the saved version.')
    await userEvent.clear(field)
    await userEvent.type(field, 'Bug hunt')
    await waitFor(() => expect(action).toBeEnabled())
  })

  it.each([
    ['on an agents workflow', () => STORED],
    ['to a non-admin', () => { adminFlag.isAdmin = false; return engineeringFlow }],
    ['without the engineering module', () => { engineering.available = false; return engineeringFlow }],
  ])('is not offered %s', async (_case, arrange) => {
    const view = arrange()
    renderAt('/agents/workflows/wf_1', { 'GET /workflows/wf_1': () => view })
    // (the editor has read the workflow: the page knows its kind)
    expect(await screen.findByRole('button', { name: 'Export' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start a run' })).toBeNull()
  })
})
