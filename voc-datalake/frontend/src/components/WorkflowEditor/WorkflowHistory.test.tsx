/**
 * @fileoverview The editor's revision History against a mocked `/workflows` API:
 * the saved revisions newest first with the current one marked, a revision's
 * summary and its diff against the current revision, restore into the draft
 * (unsaved; confirmed first when the draft has edits), and a read-only history
 * for a viewer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { fileInput, jsonFile, withPrdStep, workflowView } from '@test/workflowFixtures'
import { emptyDefinition } from './model-fixtures'
import type { WorkflowDefinition } from '../../api/workflowsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { WorkflowEditor } = await import('./WorkflowEditor')

/** Revision 1: start → write the PRD → end. */
const OLDER: WorkflowDefinition = withPrdStep(emptyDefinition('Research flow'))
/** Revision 2 (current): start → end. */
const CURRENT: WorkflowDefinition = emptyDefinition('Research flow')

const REVISIONS = [
  { revision: 2, saved_at: '2026-10-02T09:00:00Z', saved_by_username: 'alice' },
  { revision: 1, saved_at: '2026-10-01T09:00:00Z', saved_by_username: 'bob' },
]

const revisionAnswer = (revision: number, definition: WorkflowDefinition, by: string) => () => ({
  workflow_id: 'wf_1', revision, name: definition.name, definition,
  saved_at: `2026-10-0${revision}T09:00:00Z`, saved_by_username: by,
})

function routes() {
  route({
    'GET /workflows/wf_1': () => ({ ...workflowView(2, CURRENT), revisions: REVISIONS }),
    'GET /workflows/wf_1/revisions/2': revisionAnswer(2, CURRENT, 'alice'),
    'GET /workflows/wf_1/revisions/1': revisionAnswer(1, OLDER, 'bob'),
    'POST /workflows/validate': () => ({ valid: true, errors: [] }),
  })
}

async function openHistory(canEdit = true) {
  const utils = renderWithQueryClient(<WorkflowEditor workflowId="wf_1" canEdit={canEdit} />)
  await userEvent.click(await screen.findByRole('button', { name: 'History' }))
  return { ...utils, dialog: await screen.findByRole('dialog', { name: 'Revision history' }) }
}

/** The dialog's two revision rows, newest first. */
function revisionRows(dialog: HTMLElement): [HTMLElement, HTMLElement] {
  const [newest, older, ...rest] = within(within(dialog).getByRole('list', { name: 'Revisions' })).getAllByRole('button')
  if (newest === undefined || older === undefined || rest.length > 0) throw new Error('expected exactly two revision rows')
  return [newest, older]
}

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
  routes()
})

describe('WorkflowEditor — History', () => {
  it('announces that the History button opens a dialog', async () => {
    renderWithQueryClient(<WorkflowEditor workflowId="wf_1" canEdit />)
    expect(await screen.findByRole('button', { name: 'History' })).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('lists the saved revisions newest first, with the current one marked', async () => {
    const { dialog } = await openHistory()
    const [newest, older] = revisionRows(dialog)
    expect([newest, older].map((row) => within(row).getByText(/^Revision \d$/).textContent)).toStrictEqual(['Revision 2', 'Revision 1'])
    expect(within(newest).getByText('Current')).toBeInTheDocument()
    expect(within(older).queryByText('Current')).not.toBeInTheDocument()
  })

  it('opens on the current revision, with who saved each one', async () => {
    const { dialog } = await openHistory()
    const [newest, older] = revisionRows(dialog)
    expect(newest).toHaveAttribute('aria-current', 'true')
    expect(within(older).getByText('Saved by bob')).toBeInTheDocument()
    expect(await within(dialog).findByText('This is the current revision.')).toBeInTheDocument()
  })

  it('shows an older revision’s counts and what restoring it would change', async () => {
    const { dialog } = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /Revision 1/ }))
    expect(await within(dialog).findByText('3 steps · 2 arrows')).toBeInTheDocument()
    const changes = within(dialog).getByRole('region', { name: 'Restoring it would change' })
    expect(within(changes).getByText('Write the PRD')).toBeInTheDocument()
  })

  it('restores a revision into the draft without saving it', async () => {
    const { dialog } = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /Revision 1/ }))
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Restore into editor' }))
    expect(screen.queryByRole('dialog', { name: 'Revision history' })).not.toBeInTheDocument()
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('asks before a restore replaces unsaved edits, and keeps them on cancel', async () => {
    const { container } = renderWithQueryClient(<WorkflowEditor workflowId="wf_1" canEdit />)
    await screen.findByRole('button', { name: 'History' })
    await userEvent.upload(fileInput(container), jsonFile(JSON.stringify({ ...CURRENT, name: 'My edit' })))
    await screen.findByText('Unsaved changes')
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    const dialog = await screen.findByRole('dialog', { name: 'Revision history' })
    await userEvent.click(within(dialog).getByRole('button', { name: /Revision 1/ }))
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Restore into editor' }))
    expect(await screen.findByText('Replace your unsaved changes?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('My edit')).toBeInTheDocument()
  })

  it('lets a viewer browse the history but not restore', async () => {
    const { dialog } = await openHistory(false)
    await userEvent.click(within(dialog).getByRole('button', { name: /Revision 1/ }))
    expect(await within(dialog).findByText('3 steps · 2 arrows')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Restore into editor' })).not.toBeInTheDocument()
  })

  it('says so when a revision cannot be loaded', async () => {
    route({
      'GET /workflows/wf_1': () => ({ ...workflowView(2, CURRENT), revisions: REVISIONS }),
      'GET /workflows/wf_1/revisions/2': revisionAnswer(2, CURRENT, 'alice'),
      'POST /workflows/validate': () => ({ valid: true, errors: [] }),
    })
    const { dialog } = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /Revision 1/ }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This revision could not be loaded.')
  })
})
