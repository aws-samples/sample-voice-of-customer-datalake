/**
 * @fileoverview Agents → Runs against the shared fixture: the month's runs newest first, each opening its workspace
 * and naming the run it was resumed from; the month, flow and status filters read from the query (a bad one as none)
 * and written back to it; the next page by its cursor.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { defined } from '@test/defined'
import { currentMonth } from '../../../api/engineeringSpendApi'
import { calledEndpoints } from '@test/runWorkspaceHarness'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import fixture from '@test/engineeringRunWorkspace.json'
import { RunsView } from './RunsView'
import { runsQueryOf } from './runsFilters'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const LIST = '/agents/engineering/runs'
const NO_RUNS = { runs: [], next: null }
const FLOW = { workflow_id: 'wf_7c2d9e41a0b3', name: 'Fix the reported bugs', kind: 'engineering', status: 'active' }

function renderRuns(search: string) {
  const router = createMemoryRouter([{ path: '/agents/runs', element: <RunsView /> }], { initialEntries: [`/agents/runs${search}`] })
  renderWithQueryClient(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({
    [`GET ${LIST}?month=2026-11`]: () => fixture.runs.answer,
    [`GET ${LIST}?month=2026-11&status=stopped`]: () => ({ runs: [fixture.runs.answer.runs[2]], next: 'page-2' }),
    [`GET ${LIST}?month=2026-11&status=stopped&cursor=page-2`]: () => ({ runs: [{ ...fixture.runs.answer.runs[2], run_id: 'OLDER' }], next: null }),
    // (nothing in October: the empty states)
    [`GET ${LIST}?month=2026-10&flow=wf_0123456789ab`]: () => NO_RUNS,
    [`GET ${LIST}?month=2026-10&status=needs_human`]: () => NO_RUNS,
    'GET /workflows': () => ({ items: [FLOW] }),
    // (7.53.00: the run requests above the list, none waiting: RunRequests.test.tsx)
    'GET /agents/engineering/requests': () => ({ requests: [] }),
  })
})

describe('the Runs list', () => {
  it('lists the month\'s runs, each opening its workspace, a child naming its parent', async () => {
    renderRuns('?month=2026-11')
    const links = await screen.findAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toStrictEqual(fixture.runs.answer.runs.map((run) => `/agents/engineering/${run.run_id}`))
    expect(within(links[1] ?? document.body).getByText(/Resumed from run/)).toHaveTextContent(fixture.ended_run_id)
  })

  it('narrows the list by status in the query, and reads the next page by its cursor', async () => {
    const router = renderRuns('?month=2026-11')
    await screen.findAllByRole('link')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'stopped')
    await waitFor(() => expect(router.state.location.search).toBe('?month=2026-11&status=stopped'))
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(calledEndpoints()).toContain(`${LIST}?month=2026-11&status=stopped&cursor=page-2`))
  })
})

describe('the Runs filters and empty states', () => {
  it('names each run\'s flow by the library, and narrows the list to a flow or to another month', async () => {
    const router = renderRuns('?month=2026-11')
    const [first] = await screen.findAllByRole('link')
    expect(first).toHaveTextContent('Fix the reported bugs')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Flow' }), FLOW.workflow_id)
    await waitFor(() => expect(router.state.location.search).toBe(`?month=2026-11&flow=${FLOW.workflow_id}`))
    const months = screen.getByRole('combobox', { name: 'Month' })
    const other = defined(within(months).getAllByRole('option').map((option) => option.getAttribute('value')).find((month) => month !== '2026-11') ?? undefined)
    await userEvent.selectOptions(months, other)
    await waitFor(() => expect(router.state.location.search).toBe(`?month=${other}&flow=${FLOW.workflow_id}`))
  })

  it('keeps a flow the library no longer lists, by its id, and says no run matches', async () => {
    renderRuns('?month=2026-10&flow=wf_0123456789ab')
    expect(await screen.findByText('No run started in this month.')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Flow' })).toHaveDisplayValue('wf_0123456789ab')
  })

  it('says nothing needs you under the Needs-a-person filter, and shows every run on Show all runs', async () => {
    const router = renderRuns('?month=2026-10&status=needs_human')
    await userEvent.click(await screen.findByRole('button', { name: 'Show all runs' }))
    await waitFor(() => expect(router.state.location.search).toBe('?month=2026-10'))
  })

  it('says no run has started yet this month, with the way to the automations', async () => {
    routeFetchApi({
      [`GET ${LIST}?month=${currentMonth()}`]: () => NO_RUNS,
      'GET /workflows': () => ({ items: [] }),
      'GET /agents/engineering/requests': () => ({ requests: [] }),
    })
    renderRuns('')
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to Automations' })).toHaveAttribute('href', '/agents')
  })
})

describe('runsQueryOf', () => {
  it('reads each filter as the server checks it, a bad one as none', () => {
    const now = new Date('2026-11-17T12:00:00Z')
    expect(runsQueryOf(new URLSearchParams('month=2026-10&flow=wf_1&status=failed'), now)).toStrictEqual({ month: '2026-10', flow: 'wf_1', status: 'failed' })
    expect(runsQueryOf(new URLSearchParams('month=26-1&flow=a%23b&status=lost'), now)).toStrictEqual({ month: '2026-11', flow: '', status: '' })
  })
})
