/**
 * @fileoverview The workflow editor against a mocked `/workflows` API: Save
 * creates a revision with `expected_revision`, a 409 shows the conflict state
 * and keeps the draft, Save as creates a copy of the draft, validation errors
 * show inline, and the built-in template is copy-only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { wfEdge, workflowView } from '@test/workflowFixtures'
import { WORKFLOW_SCHEMA, workflowDefinitionSchema } from '../../api/workflowsApi'
import { emptyDefinition } from './model-fixtures'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { WorkflowEditor } = await import('./WorkflowEditor')

const STORED: WorkflowDefinition = emptyDefinition('Research flow')

/** A valid definition that differs from {@link STORED} (one step in between). */
const EDITED: WorkflowDefinition = {
  schema: WORKFLOW_SCHEMA,
  name: 'Research flow',
  nodes: [
    ...STORED.nodes,
    { id: 'prd', type: 'write_prd', position: { x: 0, y: 140 }, data: { title: 'Write the PRD', role: 'worker' } },
  ],
  edges: [wfEdge('e1', 'start', 'prd'), wfEdge('e2', 'prd', 'end')],
  loops: [],
}

const view = (revision: number, definition: WorkflowDefinition, extra: Record<string, unknown> = {}) =>
  workflowView(revision, definition, { slug: 'research-flow', ...extra })

const baseRoutes = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  'GET /workflows/wf_1': () => view(3, STORED),
  'POST /workflows/validate': () => ({ valid: true, errors: [] }),
  ...extra,
})

async function renderEditor(canEdit = true) {
  const utils = renderWithQueryClient(<WorkflowEditor workflowId="wf_1" canEdit={canEdit} />)
  await screen.findByText('Revision 3')
  return utils
}

/** A JSON file; jsdom's File has no `text()`, so the instance gets one. */
function jsonFile(content: string): File {
  const file = new File([content], 'flow.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) })
  return file
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input')
  return input
}

/** Replace the draft through the Import file input. */
async function importDraft(container: HTMLElement, definition: unknown) {
  await userEvent.upload(fileInput(container), jsonFile(JSON.stringify(definition)))
  await screen.findByText('Unsaved changes')
}

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
})

describe('WorkflowEditor — Save', () => {
  it('starts clean with Save disabled', async () => {
    route(baseRoutes())
    await renderEditor()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  it('creates a revision with the expected revision', async () => {
    const stored = { current: view(3, STORED) }
    const save = vi.fn((_body: unknown) => {
      stored.current = view(4, EDITED)
      return stored.current
    })
    route(baseRoutes({ 'GET /workflows/wf_1': () => stored.current, 'PUT /workflows/wf_1': save }))
    const { container } = await renderEditor()
    await importDraft(container, EDITED)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ definition: EDITED, expected_revision: 3 }))
    expect(await screen.findByText('Revision 4')).toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  it('shows the conflict state on 409 and keeps the draft', async () => {
    route(baseRoutes({ 'PUT /workflows/wf_1': () => { throw new Error('API Error: 409') } }))
    const { container } = await renderEditor()
    await importDraft(container, EDITED)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Someone saved a newer revision meanwhile.')
    expect(screen.queryByText("The workflow couldn't be saved.")).not.toBeInTheDocument()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
  })

  it('reloads the latest revision from the conflict banner', async () => {
    const get = vi.fn((_body: unknown) => view(3, STORED))
    route(baseRoutes({ 'GET /workflows/wf_1': get, 'PUT /workflows/wf_1': () => { throw new Error('API Error: 409') } }))
    const { container } = await renderEditor()
    await importDraft(container, EDITED)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    get.mockImplementation(() => view(5, STORED))
    await userEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Load the latest' }))
    expect(await screen.findByText('Revision 5')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports any other failure as a save failure', async () => {
    route(baseRoutes({ 'PUT /workflows/wf_1': () => { throw new Error('API Error: 500') } }))
    const { container } = await renderEditor()
    await importDraft(container, EDITED)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText("The workflow couldn't be saved.")).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('WorkflowEditor — Save as, import, validation', () => {
  it('saves the draft as a new workflow under the chosen name', async () => {
    const create = vi.fn((_body: unknown) => view(1, { ...EDITED, name: 'My copy' }, { workflow_id: 'wf_2' }))
    route(baseRoutes({ 'POST /workflows': create }))
    const onSavedAs = vi.fn()
    const { container } = renderWithQueryClient(<WorkflowEditor workflowId="wf_1" canEdit onSavedAs={onSavedAs} />)
    await screen.findByText('Revision 3')
    await importDraft(container, EDITED)
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText('Workflow name')
    expect(name).toHaveValue('Research flow (copy)')
    await userEvent.clear(name)
    await userEvent.type(name, 'My copy')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save as…' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith({ definition: { ...EDITED, name: 'My copy' } }))
    await waitFor(() => expect(onSavedAs).toHaveBeenCalledWith(expect.objectContaining({ workflow_id: 'wf_2' })))
  })

  it('refuses a file that is not a workflow', async () => {
    route(baseRoutes())
    const { container } = await renderEditor()
    await userEvent.upload(fileInput(container), jsonFile('not json'))
    expect(await screen.findByText('That file is not a valid workflow.')).toBeInTheDocument()
  })

  it('shows local validation errors inline on the step', async () => {
    route(baseRoutes())
    await renderEditor()
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Steps' })).getByRole('button', { name: 'Write PRD' }))
    const panel = screen.getByRole('complementary', { name: 'Step settings' })
    expect(await within(panel).findByText('this step is not connected to the start')).toBeInTheDocument()
    expect(screen.getByText('1 issue')).toBeInTheDocument()
  })

  it('does not save a draft that breaks the local rules', async () => {
    const save = vi.fn((_body: unknown) => view(4, EDITED))
    route(baseRoutes({ 'PUT /workflows/wf_1': save }))
    await renderEditor()
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Steps' })).getByRole('button', { name: 'Write PRD' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/fix the issues and save again/)).toBeInTheDocument()
    expect(save).not.toHaveBeenCalledWith(expect.anything())
  })

  it('shows the server validation errors that are not pinned to a step', async () => {
    route(baseRoutes({ 'POST /workflows/validate': () => ({ valid: false, errors: [{ message: 'the budget is too small' }] }) }))
    const { container } = await renderEditor()
    await importDraft(container, EDITED)
    const list = await screen.findByRole('list', { name: 'Workflow issues' }, { timeout: 2000 })
    expect(list).toHaveTextContent('the budget is too small')
  })
})

describe('WorkflowEditor — read-only', () => {
  it('offers no editing buttons without edit rights', async () => {
    route(baseRoutes())
    await renderEditor(false)
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Steps' })).getByRole('button', { name: 'Write PRD' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  it('keeps the built-in template copy-only', async () => {
    route(baseRoutes({ 'GET /workflows/wf_1': () => view(3, STORED, { builtin: true }) }))
    const { container } = await renderEditor()
    expect(screen.getByText('Built-in template — save a copy to change it.')).toBeInTheDocument()
    await importDraft(container, EDITED)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save as…' })).toBeEnabled()
  })

  it('shows a load failure', async () => {
    route({})
    renderWithQueryClient(<WorkflowEditor workflowId="wf_1" canEdit />)
    expect(await screen.findByText("The workflow couldn't be loaded.")).toBeInTheDocument()
  })
})

/** A stored workflow with one loop (review ⇄ revise), for the loop-frame click. */
const LOOPED: WorkflowDefinition = {
  schema: WORKFLOW_SCHEMA,
  name: 'Looped',
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start', params: {} } },
    { id: 'review', type: 'persona_review', position: { x: 0, y: 140 }, data: { title: 'Review', role: 'persona', params: { target: 'prfaq' } } },
    { id: 'revise', type: 'revise_document', position: { x: 280, y: 140 }, data: { title: 'Revise', role: 'worker', params: { target: 'prfaq' } } },
    { id: 'end', type: 'end', position: { x: 0, y: 280 }, data: { title: 'Done', params: { status: 'completed' } } },
  ],
  edges: [
    wfEdge('e1', 'start', 'review'),
    { id: 'e2', source: 'review', target: 'revise', label: 'not_agreed' },
    wfEdge('e3', 'revise', 'review'),
    { id: 'e4', source: 'review', target: 'end', label: 'agreed' },
  ],
  loops: [{ node_ids: ['review', 'revise'], until: 'persona_agreement', max_rounds: 3 }],
}

const panelOf = () => screen.getByRole('complementary', { name: 'Step settings' })
const paletteButton = (name: string) => within(screen.getByRole('navigation', { name: 'Steps' })).getByRole('button', { name })

describe('WorkflowEditor — clicking a loop', () => {
  it('opens the loop settings from its frame on the canvas', async () => {
    route(baseRoutes({ 'GET /workflows/wf_1': () => view(3, LOOPED) }))
    await renderEditor()
    // fireEvent: userEvent's pointer sequence sends a mousedown that d3-zoom reads `view` from, which jsdom
    // leaves null; React Flow selects a node on `click`, which is what this sends.
    fireEvent.click(await screen.findByTestId('loop-frame-label-0'))
    const loop = await within(panelOf()).findByRole('region', { name: 'Loop 1' })
    expect(within(loop).getByLabelText('Until')).toHaveValue('persona_agreement')
    expect(within(loop).getByLabelText('Maximum rounds')).toHaveValue(3)
  })

  it('names the loop frame for assistive tech and keeps it read-only for viewers', async () => {
    route(baseRoutes({ 'GET /workflows/wf_1': () => view(3, LOOPED) }))
    await renderEditor(false)
    // React Flow keeps a node `visibility: hidden` until measured (jsdom never measures), so the
    // wrapper is found by its test id and its role and accessible name are asserted directly.
    const frame = await screen.findByTestId('rf__node-loop:0')
    expect(frame).toHaveAttribute('role', 'group')
    expect(frame).toHaveAttribute('aria-label', 'Loop 1: until personas agree, at most 3 rounds')
    fireEvent.click(within(frame).getByTestId('loop-frame-label-0'))
    const loop = await within(panelOf()).findByRole('region', { name: 'Loop 1' })
    expect(within(loop).getByLabelText('Maximum rounds')).toBeDisabled()
  })
})

describe('WorkflowEditor — building by hand', () => {
  it('clears the canvas, builds a pass/fail branch from the palette and panel, and saves it as a copy', async () => {
    const create = vi.fn((body: unknown) => view(1, emptyDefinition('Hand-built'), { workflow_id: 'wf_2', echoed: body }))
    route(baseRoutes({ 'POST /workflows': create }))
    await renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'Clear canvas' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear canvas' }))
    expect(await within(panelOf()).findByText('The canvas is empty: add steps from the palette.')).toBeInTheDocument()

    // Each palette add selects the new step; titles come from the palette, ids are minted.
    for (const label of ['Start', 'Final review', 'End', 'End']) await userEvent.click(paletteButton(label))
    const addArrow = async (from: string, to: string, condition?: string) => {
      await userEvent.click(within(panelOf()).getByRole('button', { name: 'Workflow settings' }))
      await userEvent.click(within(panelOf()).getAllByRole('button', { name: `Configure step ${from}` })[0] ?? panelOf())
      const add = within(panelOf()).getByRole('group', { name: 'Add an arrow' })
      await userEvent.selectOptions(within(add).getByLabelText('To step'), to)
      if (condition !== undefined) await userEvent.selectOptions(within(add).getByLabelText('Condition'), condition)
      await userEvent.click(within(add).getByRole('button', { name: 'Add arrow' }))
    }
    // The second End is renamed so the two ends can be told apart.
    await userEvent.clear(within(panelOf()).getByLabelText('Title'))
    await userEvent.type(within(panelOf()).getByLabelText('Title'), 'Needs a human')
    await addArrow('Start', 'Final review')
    await addArrow('Final review', 'End', 'Pass')
    await addArrow('Final review', 'Needs a human', 'Fail')
    expect(await screen.findByText('Valid — not saved yet.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save as…' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.anything()))
    const body: unknown = create.mock.calls[0]?.[0]
    const edges = isRecordWithDefinition(body) ? body.definition.edges.map((e) => e.label ?? 'always') : []
    expect([...edges].sort((a, b) => a.localeCompare(b))).toStrictEqual(['always', 'fail', 'pass'])
  })
})

function isRecordWithDefinition(value: unknown): value is { definition: WorkflowDefinition } {
  return typeof value === 'object' && value !== null && 'definition' in value
    && workflowDefinitionSchema.safeParse(value.definition).success
}
