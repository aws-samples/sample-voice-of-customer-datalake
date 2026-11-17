/**
 * @fileoverview Restart run on an ended run, against the shared fixture: offered only once the run has ended, it asks
 * how (resume or restart), on which commit and which agents, posts `…/restart` with `confirm: true`, and opens the
 * child run; an answer that could not be read names the child to open (and keeps the dialog from starting another);
 * a refusal says the server's reason. The child's workspace names the run it was resumed from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../../lib/errors'
import { adminFlag, resetFetchApi, sentFetchApiBody, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { renderWorkspace, workspaceRoutes } from '@test/runWorkspaceHarness'
import fixture from '@test/engineeringRunWorkspace.json'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

stubResizeObserverForSuite()

const ENDED = `/agents/engineering/${fixture.ended_run_id}`
const CHILD = `/agents/engineering/${fixture.child_run_id}`
const ENDED_AGENTS = [{ agent: 'fixer-1', role: 'fixer', task_id: 'task-export', status: 'stopped', attempt: 1 }]

function endedRoutes(restart: RouteHandler = () => fixture.restart.answer) {
  workspaceRoutes({
    [`GET ${ENDED}`]: () => ({ ...fixture.ended_overview.answer, agents: ENDED_AGENTS }),
    [`GET ${CHILD}`]: () => fixture.child_overview.answer,
    [`POST ${fixture.restart.path}`]: restart,
  })
}

async function openDialog() {
  await userEvent.click(await screen.findByRole('button', { name: 'Restart run' }))
  return within(screen.getByRole('dialog', { name: 'Restart this run?' }))
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('Restart run', () => {
  it('is offered once the run has ended, never on a run under way', async () => {
    workspaceRoutes()
    renderWorkspace(`/agents/engineering/${fixture.run_id}`)
    expect(await screen.findByRole('button', { name: 'Pause — The whole run' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restart run' })).not.toBeInTheDocument()
  })

  it('resumes from the agents\' checkpoints on the run\'s own commit by default, and opens the child', async () => {
    endedRoutes()
    const router = renderWorkspace(ENDED)
    const dialog = await openDialog()
    await userEvent.click(dialog.getByRole('button', { name: 'Start the new run' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/engineering/${fixture.restart.answer.run.run_id}`))
    expect(sentFetchApiBody(fixture.restart.path, 'POST')).toStrictEqual(fixture.restart.body)
  })

  it('restarts the agents ticked afresh on the repository\'s head', async () => {
    endedRoutes()
    renderWorkspace(ENDED)
    const dialog = await openDialog()
    await userEvent.click(dialog.getByRole('radio', { name: 'Restart: their tasks afresh' }))
    await userEvent.click(dialog.getByRole('radio', { name: /The repository's head now/ }))
    await userEvent.click(dialog.getByRole('checkbox', { name: /fixer-1/ }))
    await userEvent.click(dialog.getByRole('button', { name: 'Start the new run' }))
    await waitFor(() => expect(sentFetchApiBody(fixture.restart.path, 'POST'))
      .toStrictEqual({ mode: 'restart', base: 'head', agents: ['fixer-1'], confirm: true }))
  })

  it('names the child to open when the answer could not be read, and starts no other', async () => {
    endedRoutes(() => { throw new ApiError(503, 'run C1 may have been started: open it before you restart this run again', undefined, 'C1') })
    renderWorkspace(ENDED)
    const dialog = await openDialog()
    await userEvent.click(dialog.getByRole('button', { name: 'Start the new run' }))
    expect(await dialog.findByRole('link', { name: 'Open the run' })).toHaveAttribute('href', '/agents/engineering/C1')
    expect(dialog.getByRole('button', { name: 'Start the new run' })).toBeDisabled()
  })

  it('shows the server\'s reason for a refusal', async () => {
    endedRoutes(() => { throw new ApiError(409, 'The run is live: restart one of its agents with the restart signal') })
    renderWorkspace(ENDED)
    const dialog = await openDialog()
    await userEvent.click(dialog.getByRole('button', { name: 'Start the new run' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('The run is live: restart one of its agents with the restart signal')
  })

  it('links a child run to the run it was resumed from, and the parent to its child', async () => {
    endedRoutes()
    renderWorkspace(CHILD)
    expect(await screen.findByText('Resumed from run')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: fixture.ended_run_id })).toHaveAttribute('href', ENDED)
  })
})
