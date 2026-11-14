/**
 * The workspace's export section: admins only; Start an export, its status polled while it is being made and no
 * longer once it is done or failed, Download opening a fresh 15-minute link, the 7-day window and each refusal in
 * words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { stubLocationAssign } from '../../test/location'
import { createTestQueryClient } from '../../test/query-client'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import WorkspaceExportCard, { EXPORT_POLL_MS } from './WorkspaceExportCard'

const EXPORT = '/me/workspaces/current/export'
const COMPLETED = {
  id: 'ex_01JCACME0000000000000000A1', status: 'completed', created_at: '2026-11-13T09:00:00Z',
  completed_at: '2026-11-13T09:05:00Z', expires_at: '2026-11-20T09:05:00Z',
}
const RUNNING = { id: 'ex_01JCACME0000000000000000A1', status: 'running', created_at: '2026-11-13T09:00:00Z' }

function renderCard(routes: Record<string, RouteHandler>, isAdmin = true) {
  routeFetchApi(routes)
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <WorkspaceExportCard workspaceId="ws_01JCACME0000000000000000A1" isAdmin={isAdmin} />
    </QueryClientProvider>,
  )
}

const statusReads = () => vi.mocked(fetchApi).mock.calls.filter(([path, init]) => path === EXPORT && init === undefined).length

beforeEach(() => resetFetchApi())
afterEach(() => vi.useRealTimers())

describe('WorkspaceExportCard', () => {
  it('tells a member who is not an admin who can export, and reads nothing', () => {
    renderCard({}, false)
    expect(screen.getByText("Only this workspace's admins can export it.")).toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('starts an export when there is none, then shows it queued', async () => {
    const queued = { id: 'ex_1', status: 'queued', created_at: '2026-11-13T09:00:00Z' }
    const exports: unknown[] = []
    const started = vi.fn<RouteHandler>(() => {
      exports.push(queued)
      return { export: queued }
    })
    renderCard({ [`GET ${EXPORT}`]: () => ({ export: exports.at(-1) ?? null }), [`POST ${EXPORT}`]: started })
    expect(await screen.findByText('No export yet.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Start an export' }))
    expect(await screen.findByText('Queued')).toBeInTheDocument()
    expect(started).toHaveBeenCalledExactlyOnceWith({})
    // While it is being made, a second export cannot be started.
    expect(screen.getByRole('button', { name: 'Start an export' })).toBeDisabled()
  })

  it('polls while the export is running and stops once it is completed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const answers = [RUNNING, COMPLETED]
    renderCard({ [`GET ${EXPORT}`]: () => ({ export: answers.length > 1 ? answers.shift() : answers[0] }) })
    expect(await screen.findByText('Running')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS) })
    expect(await screen.findByText('Ready')).toBeInTheDocument()
    const reads = statusReads()
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS * 3) })
    expect(statusReads()).toBe(reads)
  })

  it('does not poll a failed export, and says to start it again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderCard({ [`GET ${EXPORT}`]: () => ({ export: { ...RUNNING, status: 'failed' } }) })
    expect(await screen.findByText('The export stopped before it finished. Start it again.')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS * 3) })
    expect(statusReads()).toBe(1)
  })

  it('downloads a completed export through a fresh link, and says how long each link works', async () => {
    const assign = stubLocationAssign('/w/acme/workspace-settings')
    renderCard({
      [`GET ${EXPORT}`]: () => ({ export: COMPLETED }),
      [`POST ${EXPORT}/link`]: () => ({ link: { id: COMPLETED.id, url: 'https://example.com/x.zip', expires_in: 900, expires_at: 'z' } }),
    })
    expect(await screen.findByText(/You can download it until/)).toBeInTheDocument()
    expect(screen.getByText('Each download link works for 15 minutes.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    // The link is an attachment: the page goes to it (no popup a blocker could swallow) and stays.
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('https://example.com/x.zip'))
  })

  it.each([
    ['an export already running', `POST ${EXPORT}`, 'An export of this workspace is already running: wait for it to finish, then start another',
      'An export of this workspace is already running. Wait for it to finish.', null],
    ['an erasure running', `POST ${EXPORT}`, 'An erasure is running in this workspace: start the export when it ends',
      'An erasure is running in this workspace. Start the export when it ends.', null],
    ['a link past the 7 days', `POST ${EXPORT}/link`, 'No export can be downloaded: the newest is not completed, or its 7 days are over. Start a new export',
      'This export can no longer be downloaded. Start a new export.', COMPLETED],
  ])('says %s in words', async (_case, route, reason, shown, current) => {
    renderCard({
      [`GET ${EXPORT}`]: () => ({ export: current }),
      [route]: () => { throw new ApiError(409, reason) },
    })
    const button = await screen.findByRole('button', { name: current === null ? 'Start an export' : 'Download' })
    await userEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent(shown)
  })

  it('says an expired or erased export cannot be downloaded and offers a new one', async () => {
    renderCard({ [`GET ${EXPORT}`]: () => ({ export: { ...COMPLETED, status: 'erased' } }) })
    expect(await screen.findByText('An erasure reached this workspace, so this export was deleted. Start a new export.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start an export' })).toBeEnabled()
  })

  it('offers Try again when the status cannot be read', async () => {
    renderCard({ [`GET ${EXPORT}`]: () => { throw new ApiError(500, 'Failed to read the export') } })
    expect(await screen.findByRole('alert')).toHaveTextContent("The export's status could not be loaded.")
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
