/**
 * @fileoverview SystemRequestLines: "Show the whole request" loads every line of
 * one invocation (`GET /logs/system/request`), polling a running search with its
 * query id until it completes; a failed search can be retried.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { normalizeSystemRequest } from '../../api/systemDiagnostics'
import type { SystemLogGroup } from '../../api/systemLogs'
import SystemRequestLines from './SystemRequestLines'

const mockGetSystemRequest = vi.fn<(params: unknown) => Promise<unknown>>()
vi.mock('../../api/client', () => ({
  api: { getSystemRequest: (params: unknown) => mockGetSystemRequest(params).then(normalizeSystemRequest) },
}))

const GROUP: SystemLogGroup = {
  function: 'projects-assist', source: 'lambda', level: 'ERROR', message: 'Avatar failed', sample: 'Avatar failed',
  count: 1, first_seen: '2026-10-27T08:40:00.000Z', last_seen: '2026-10-27T08:44:43.123Z',
  request_id: '7f3c2a10-4b8e-4d1a-9c55-0e2b6d9a1f37',
}
const LINES = [
  { timestamp: '2026-10-27T08:44:40Z', level: 'INFO', message: 'START RequestId: 7f3c' },
  { timestamp: '2026-10-27T08:44:41Z', level: 'ERROR', message: 'Traceback (most recent call last):\n  File "avatar.py"' },
]

describe('SystemRequestLines', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads nothing until asked', () => {
    renderWithQueryClient(<SystemRequestLines group={GROUP} />)

    expect(screen.getByRole('button', { name: 'Show the whole request' })).toBeInTheDocument()
    expect(mockGetSystemRequest).not.toHaveBeenCalled()
  })

  it('polls a running search with its query id, then lists every line oldest first', async () => {
    const user = userEvent.setup()
    mockGetSystemRequest
      .mockResolvedValueOnce({ status: 'running', query_id: 'q-7', lines: [], truncated: false })
      .mockResolvedValueOnce({ status: 'complete', lines: LINES, truncated: true })
    renderWithQueryClient(<SystemRequestLines group={GROUP} />)

    await user.click(screen.getByRole('button', { name: 'Show the whole request' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Reading every line of this request…')
    expect(await screen.findByText('2 lines of this request', {}, { timeout: 4000 })).toBeInTheDocument()
    const items = screen.getAllByRole('listitem')
    expect([
      ...items.map((item) => item.textContent.includes('START')),
      screen.queryByText('Showing the first 500 lines') !== null,
      screen.getByText('ERROR').classList.contains('text-danger'),
    ]).toStrictEqual([true, false, true, true])
    const at = GROUP.last_seen
    expect(mockGetSystemRequest.mock.calls).toStrictEqual([
      [{ function: 'projects-assist', request_id: GROUP.request_id, at, query_id: undefined }],
      [{ function: 'projects-assist', request_id: GROUP.request_id, at, query_id: 'q-7' }],
    ])
  })

  it('shows a failed search with a retry that starts a fresh one', async () => {
    const user = userEvent.setup()
    mockGetSystemRequest
      .mockResolvedValueOnce({ status: 'failed', lines: [] })
      .mockResolvedValueOnce({ status: 'complete', lines: LINES, truncated: false })
    renderWithQueryClient(<SystemRequestLines group={GROUP} />)

    await user.click(screen.getByRole('button', { name: 'Show the whole request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The search for this request failed. Try again.')
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('2 lines of this request')).toBeInTheDocument()
    expect(mockGetSystemRequest).toHaveBeenLastCalledWith(expect.objectContaining({ query_id: undefined }))
  })

  it('says so when the request has no lines (its logs may have expired)', async () => {
    const user = userEvent.setup()
    mockGetSystemRequest.mockResolvedValueOnce({ status: 'complete', lines: [], truncated: false })
    renderWithQueryClient(<SystemRequestLines group={GROUP} />)

    await user.click(screen.getByRole('button', { name: 'Show the whole request' }))

    expect(await screen.findByText(/No lines found for this request/)).toBeInTheDocument()
  })

  it('shows a load error when the route itself fails (unknown function: 404)', async () => {
    const user = userEvent.setup()
    mockGetSystemRequest.mockRejectedValueOnce(new Error('API Error: 404'))
    renderWithQueryClient(<SystemRequestLines group={GROUP} />)

    await user.click(screen.getByRole('button', { name: 'Show the whole request' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The request’s lines could not be loaded.')
  })
})
