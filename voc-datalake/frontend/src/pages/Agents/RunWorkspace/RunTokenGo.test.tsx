/**
 * @fileoverview A run's go on a fine-grained token connection (7.60.00, RunTokenGo.tsx): shown only for a run whose
 * repository is a token connection's; Push with ‹login›'s token for the token's owner (the go posted once, given now or
 * given already), whose go it waits for to anyone else, and the server's refusal of a go from anyone but the owner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { appConnection } from '@test/githubAppFixtures'
import { tokenConnection } from '@test/tokenConnectionFixtures'
import { ApiError } from '../../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { RunTokenGo } = await import('./RunTokenGo')

const RUN = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'
const GO = `POST /agents/engineering/${RUN}/go`

function renderGo(connections: unknown[], routes: Record<string, RouteHandler> = {}, repository = 'Partner-Org/SDK',
  connectionId: string | null = null) {
  routeFetchApi({ 'GET /agents/engineering/connections': () => ({ connections, limit: 20 }), ...routes }, { missStatus: 500 })
  renderWithQueryClient(<RunTokenGo runId={RUN} connectionId={connectionId} repository={repository} />, createTestQueryClient())
}

const gone = () => fetchApi.mock.calls.filter(([path]) => path === `/agents/engineering/${RUN}/go`)

beforeEach(() => { resetFetchApi() })

describe('the go of a run on a token connection', () => {
  it('lets the token\'s owner push with their token, once', async () => {
    renderGo([tokenConnection('partner-sdk', 'partner-org/sdk', 30)],
      { [GO]: () => ({ go: { by: 'person:sub', at: '2026-11-20T10:00:00Z', created: true } }) })
    expect(await screen.findByText(/This run pushes with casey-dev's fine-grained token/)).toBeInTheDocument()
    const push = screen.getByRole('button', { name: "Push with casey-dev's token" })
    await userEvent.click(push)
    expect(await screen.findByRole('status')).toHaveTextContent("Your go is given: the run pushes with casey-dev's token once its gates pass.")
    await userEvent.click(push)
    expect(gone()).toHaveLength(1)
  })

  it('says a go given already as such', async () => {
    renderGo([tokenConnection('partner-sdk', 'partner-org/sdk', 30)],
      { [GO]: () => ({ go: { by: 'person:sub', at: '2026-11-20T10:00:00Z', created: false } }) })
    await userEvent.click(await screen.findByRole('button', { name: "Push with casey-dev's token" }))
    expect(await screen.findByRole('status')).toHaveTextContent('A go was given on this run already.')
  })

  it('offers no button to anyone else: it says whose go the run waits for', async () => {
    renderGo([tokenConnection('partner-sdk', 'partner-org/sdk', 30, { savedByYou: false, owner: 'Robin', login: 'robin-gh' })])
    expect(await screen.findByText('Only Robin, who saved the token, gives this run its go.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it.each([
    [new ApiError(403, 'only the owner', 'token_owner_go'), "Only the token's owner gives this run its go."],
    [new ApiError(503, 'down'), 'The go could not be given: try again.'],
  ])('says the server\'s refusal (%s)', async (error, words) => {
    renderGo([tokenConnection('partner-sdk', 'partner-org/sdk', 30)], { [GO]: () => { throw error } })
    await userEvent.click(await screen.findByRole('button', { name: "Push with casey-dev's token" }))
    expect(await screen.findByRole('alert')).toHaveTextContent(words)
  })

  it('finds the run\'s own connection by its id when the overview names it', async () => {
    renderGo([tokenConnection('partner-sdk', 'partner-org/sdk', 30)], {}, 'partner-org/sdk', 'partner-sdk')
    expect(await screen.findByRole('button', { name: "Push with casey-dev's token" })).toBeInTheDocument()
  })

  it('never takes another connection of the same repository for the run\'s own', async () => {
    renderGo([tokenConnection('partner-sdk', 'partner-org/sdk', 30)], {}, 'partner-org/sdk', 'another-id')
    await waitFor(() => { expect(fetchApi).toHaveBeenCalledWith('/agents/engineering/connections', undefined) })
    expect(screen.queryByTestId('run-token-go')).not.toBeInTheDocument()
  })

  it('shows nothing for a run on any other connection, or before the list is read', async () => {
    renderGo([appConnection('partner-sdk', 'partner-org/sdk')])
    await waitFor(() => { expect(fetchApi).toHaveBeenCalledWith('/agents/engineering/connections', undefined) })
    expect(screen.queryByTestId('run-token-go')).not.toBeInTheDocument()
  })
})
