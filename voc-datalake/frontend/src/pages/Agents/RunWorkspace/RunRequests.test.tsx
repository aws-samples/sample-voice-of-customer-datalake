/**
 * @fileoverview Agents → Runs' run requests (7.53.00, MCP for runs): the requests a local assistant made over MCP,
 * waiting for an administrator; Confirm runs the Run now and links the run, Decline starts nothing, a refusal is shown
 * in the server's words, and nothing shows while no request waits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'
import { RunRequests } from './RunRequests'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const LIST = 'GET /agents/engineering/requests'
const RUN_ID = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'
const PENDING = {
  request_id: '01JDB0000000000000000REQ01', status: 'pending', agent_id: 'ag_bug', agent_name: 'Bug fixer', issue: 42,
  prd: null, note: 'the paging one', requested_at: '2026-11-17T09:00:00Z', expires_at: '2026-11-18T09:00:00Z',
  via: 'mcp:tok_1', requested_for: 'admin-sub', decided_by: null, decided_at: null, outcome: null, run_id: null,
  engineering_run_id: null,
}
const FEATURE = { ...PENDING, request_id: '01JDB0000000000000000REQ02', agent_id: 'ag_feat', agent_name: 'Feature builder',
  issue: null, prd: { project_id: 'proj_1', document_id: 'prd_1' }, note: null }
const DECIDED = { ...PENDING, request_id: '01JDB0000000000000000REQ00', status: 'declined' }
const CONFIRM = `POST /agents/engineering/requests/${PENDING.request_id}/confirm`
const DECLINE = `POST /agents/engineering/requests/${PENDING.request_id}/decline`

function renderRequests() {
  renderWithQueryClient(<MemoryRouter><RunRequests /></MemoryRouter>)
}

beforeEach(() => {
  resetFetchApi()
})

describe('the run requests', () => {
  it('lists only the waiting requests, under their heading', async () => {
    routeFetchApi({ [LIST]: () => ({ requests: [PENDING, FEATURE, DECIDED] }) })
    renderRequests()
    expect(await screen.findAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Run requests' })).toBeInTheDocument()
  })

  it('says which automation, on what, the note as data, and which MCP token asked', async () => {
    routeFetchApi({ [LIST]: () => ({ requests: [PENDING, FEATURE] }) })
    renderRequests()
    const [bug, feature] = await screen.findAllByRole('listitem')
    expect(bug).toHaveTextContent('Bug fixer · issue #42Note: the paging oneAsked over MCP by mcp:tok_1')
    expect(feature).toHaveTextContent('Feature builder · PRD prd_1 of project proj_1Asked over MCP')
  })

  it('shows nothing while no request waits', async () => {
    routeFetchApi({ [LIST]: () => ({ requests: [DECIDED] }) })
    renderRequests()
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/agents/engineering/requests', undefined))
    expect(screen.queryByRole('heading', { name: 'Run requests' })).not.toBeInTheDocument()
  })

  it('confirms a request, which starts the run as the admin, and links the run', async () => {
    routeFetchApi({
      [LIST]: () => ({ requests: [PENDING] }),
      [CONFIRM]: () => ({ request: { ...PENDING, status: 'confirmed', outcome: 'started', engineering_run_id: RUN_ID },
                          run: { run_id: 'run_1', engineering_run_id: RUN_ID } }),
    })
    renderRequests()
    const item = await screen.findByRole('listitem')
    await userEvent.click(within(item).getByRole('button', { name: 'Confirm and run' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Confirmed: the run is starting.')
    expect(screen.getByRole('link', { name: 'Open the run' })).toHaveAttribute('href', `/agents/engineering/${RUN_ID}`)
  })

  it('declines a request: nothing starts', async () => {
    routeFetchApi({ [LIST]: () => ({ requests: [PENDING] }), [DECLINE]: () => ({ request: { ...PENDING, status: 'declined' } }) })
    renderRequests()
    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Declined: nothing started.')
    expect(fetchApi).not.toHaveBeenCalledWith(`/agents/engineering/requests/${PENDING.request_id}/confirm`, expect.anything())
  })

  it('shows a refused confirm in the server\'s words', async () => {
    routeFetchApi({
      [LIST]: () => ({ requests: [PENDING] }),
      [CONFIRM]: () => { throw new ApiError(409, 'this request is expired: it can no longer be decided') },
    })
    renderRequests()
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm and run' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('this request is expired: it can no longer be decided')
  })

  it('says so when the requests cannot be read', async () => {
    routeFetchApi({}, { missStatus: 503 })
    renderRequests()
    expect(await screen.findByRole('alert')).toHaveTextContent('The run requests could not be read.')
  })
})
