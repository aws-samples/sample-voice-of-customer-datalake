/**
 * @fileoverview SystemLogsPanel: the Logs section's System errors tab
 * (`GET /logs/system`). A running search is polled with its query id until it
 * completes; groups render one row each and expand to the newest occurrence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { normalizeSystemLogs } from '../../api/systemLogs'
import {
  normalizeSystemEnvironment, normalizeSystemFailureQueues, normalizeSystemRequest,
} from '../../api/systemDiagnostics'
import SystemLogsPanel from './SystemLogsPanel'

const mockDownloadFile = vi.hoisted(() => vi.fn<(content: string, filename: string, mimeType: string) => void>())
vi.mock('../../utils/file', () => ({ downloadFile: mockDownloadFile }))

const auth = vi.hoisted(() => ({ isAdmin: true }))
vi.mock('../../store/authStore', () => ({ useIsAdmin: () => auth.isAdmin }))

const mockGetSystemLogs = vi.fn<(params: unknown) => Promise<unknown>>()
const mockGetSystemRequest = vi.fn<(params: unknown) => Promise<unknown>>()
const mockGetQueues = vi.fn<() => Promise<unknown>>()
const mockGetEnvironment = vi.fn<() => Promise<unknown>>()
const mockGetValidationLogs = vi.fn<(params: unknown) => Promise<unknown>>()
const mockGetProcessingLogs = vi.fn<(params: unknown) => Promise<unknown>>()
vi.mock('../../api/client', () => ({
  api: {
    getSystemLogs: (params: unknown) => mockGetSystemLogs(params).then(normalizeSystemLogs),
    getSystemRequest: (params: unknown) => mockGetSystemRequest(params).then(normalizeSystemRequest),
    getSystemFailureQueues: () => mockGetQueues().then(normalizeSystemFailureQueues),
    getSystemEnvironment: () => mockGetEnvironment().then(normalizeSystemEnvironment),
    getValidationLogs: (params: unknown) => mockGetValidationLogs(params),
    getProcessingLogs: (params: unknown) => mockGetProcessingLogs(params),
  },
}))

const AVATAR_GROUP = {
  function: 'projects-assist',
  level: 'ERROR',
  message: '[PERSONA_AVATAR] FAILED - Avatar generation error: AccessDeniedException: <str>',
  sample: 'Traceback (most recent call last):\n  File "/var/task/shared/avatar.py", line 88',
  count: 3,
  first_seen: '2026-10-27T08:44:43.123Z',
  last_seen: new Date(Date.now() - 5 * 60_000).toISOString(),
  request_id: '7f3c2a10-4b8e-4d1a-9c55-0e2b6d9a1f37',
}
const TIMEOUT_GROUP = {
  function: 'chat-stream', level: 'PLATFORM', message: 'Task timed out after <n> seconds',
  sample: 'Task timed out after 900.00 seconds', count: 1,
  first_seen: '2026-10-26T08:00:00Z', last_seen: '2026-10-26T08:00:00Z', request_id: null,
}

const API_GROUP = {
  function: 'api', source: 'api', level: 'HTTP', message: 'POST /projects/{id}/personas/generate → 502 Internal server error',
  sample: 'POST /projects/proj_1/personas/generate → 502', count: 4,
  first_seen: '2026-10-27T08:00:00Z', last_seen: new Date(Date.now() - 60 * 60_000).toISOString(),
  request_id: 'c0a8e1d2-3f4b-4c5d-8e9f-0a1b2c3d4e5f',
}
const QUEUES = { queues: [{ name: 'voc-processing-dlq', messages: 2, oldest_age_seconds: 7200, sample: ['{"id":"rev_1"}'] }] }
const ENVIRONMENT = { version: '5.44.0', region: 'us-west-2', web_search: true }
const VALIDATION_LOG = {
  source_platform: 'webscraper', message_id: 'msg_1', timestamp: '2026-10-27T08:00:00Z', log_type: 'validation_failure', errors: ['text: field required'],
}
const REQUEST_LINES = [
  { timestamp: '2026-10-27T08:44:40Z', level: 'INFO', message: 'START RequestId: 7f3c' },
  { timestamp: '2026-10-27T08:44:41Z', level: 'ERROR', message: 'AccessDeniedException' },
]

const complete = (groups: unknown[], extra: object = {}) =>
  ({ status: 'complete', log_groups: 54, truncated: false, count: groups.length, groups, ...extra })

function renderPanel(days = 1) {
  return renderWithQueryClient(<SystemLogsPanel days={days} />)
}

describe('SystemLogsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.isAdmin = true
    mockGetQueues.mockResolvedValue(QUEUES)
    mockGetEnvironment.mockResolvedValue(ENVIRONMENT)
    mockGetValidationLogs.mockResolvedValue({ logs: [VALIDATION_LOG], count: 1, days: 7 })
    mockGetProcessingLogs.mockRejectedValue(new Error('API Error: 500'))
  })

  it('polls a running search with its query id until it completes', async () => {
    mockGetSystemLogs
      .mockResolvedValueOnce({ status: 'running', query_id: 'q-1,q-2', log_groups: 54, truncated: false, count: 0, groups: [] })
      .mockResolvedValueOnce(complete([AVATAR_GROUP, TIMEOUT_GROUP]))

    renderPanel()

    expect(await screen.findByText('Searching logs of 54 functions…')).toBeInTheDocument()
    expect(await screen.findByText('projects-assist', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(mockGetSystemLogs.mock.calls).toStrictEqual([
      [{ days: 1, level: 'error', query_id: undefined }],
      [{ days: 1, level: 'error', query_id: 'q-1,q-2' }],
    ])
  })

  it('renders one row per group: level badge, function, message, count, last seen', async () => {
    mockGetSystemLogs.mockResolvedValue(complete([AVATAR_GROUP, TIMEOUT_GROUP]))
    renderPanel()

    await screen.findByText('projects-assist')
    expect([screen.getByText('ERROR'), screen.getByText('PLATFORM')].map((b) => b.classList.contains('badge-danger')))
      .toStrictEqual([true, true])
    expect(screen.getByText('×3')).toHaveAttribute('title', '3 occurrences')
    expect(screen.getByText(AVATAR_GROUP.message)).toHaveAttribute('title', AVATAR_GROUP.message)
    expect(['5m ago', 'Searched the logs of 54 functions'].map((text) => screen.queryByText(text) !== null))
      .toStrictEqual([true, true])
  })

  it('downloads groups, opened request lines, queues, environment and source logs with a how-to-read note', async () => {
    const user = userEvent.setup()
    mockGetSystemLogs.mockResolvedValue(complete([AVATAR_GROUP, TIMEOUT_GROUP]))
    mockGetSystemRequest.mockResolvedValue({ status: 'complete', lines: REQUEST_LINES, truncated: false })
    renderPanel(7)

    await user.click(await screen.findByRole('button', { name: /projects-assist/ }))
    await user.click(screen.getByRole('button', { name: 'Show the whole request' }))
    await screen.findByText('AccessDeniedException')
    await screen.findByText('voc-processing-dlq')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(mockDownloadFile).toHaveBeenCalledTimes(1))
    const [content, filename, mimeType] = mockDownloadFile.mock.calls[0] ?? ['', '', '']
    const body: unknown = JSON.parse(content)
    // Only an opened request is carried: the unopened group (chat-stream) has no lines.
    expect([
      filename.startsWith('voc-system-errors-') && filename.endsWith('.json'), mimeType,
      content.match(/"request_lines":/g)?.length, content.includes('"how_to_read": "This file is an export'),
    ]).toStrictEqual([true, 'application/json', 1, true])
    expect(body).toMatchObject({
      site: window.location.origin, days: 7, level: 'error', log_groups: 54, truncated: false,
      environment: ENVIRONMENT,
      queues: QUEUES.queues,
      groups: [
        { function: 'projects-assist', count: 3, request_lines: REQUEST_LINES, request_lines_truncated: false },
        { function: 'chat-stream', level: 'PLATFORM' },
      ],
      validation_failures: [VALIDATION_LOG],
      processing_errors: { error: 'Could not be loaded at export time' },
    })
    expect(mockGetValidationLogs).toHaveBeenCalledWith({ days: 7, limit: 100 })
  })

  it('tags API Gateway and workflow rows, gives HTTP a danger badge and offers no request view for API rows', async () => {
    const user = userEvent.setup()
    mockGetSystemLogs.mockResolvedValue(complete([API_GROUP, { ...TIMEOUT_GROUP, function: 'research', source: 'workflow' }]))
    renderPanel()

    await screen.findByText(API_GROUP.message)
    expect(screen.getByText('HTTP')).toHaveClass('badge-danger')
    expect(['API', 'Workflow'].map((text) => screen.queryByText(text) !== null)).toStrictEqual([true, true])

    await user.click(screen.getByRole('button', { name: /personas\/generate/ }))
    expect(screen.queryByRole('button', { name: 'Show the whole request' })).toBeNull()
  })

  it('expands a row to the newest occurrence, its times and request id', async () => {
    const user = userEvent.setup()
    mockGetSystemLogs.mockResolvedValue(complete([AVATAR_GROUP]))
    renderPanel()

    const row = await screen.findByRole('button', { name: /projects-assist/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    await user.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/line 88/)).toBeInTheDocument()
    expect(['First seen', 'Last seen', AVATAR_GROUP.request_id].map((text) => screen.queryByText(text) !== null))
      .toStrictEqual([true, true, true])
  })

  it('asks for warnings too when the level select says so', async () => {
    const user = userEvent.setup()
    mockGetSystemLogs.mockResolvedValue(complete([]))
    renderPanel(7)
    await screen.findByText('No errors in this period')

    await user.selectOptions(screen.getByRole('combobox', { name: 'Log level' }), 'warning')

    await waitFor(() => expect(mockGetSystemLogs).toHaveBeenLastCalledWith({ days: 7, level: 'warning', query_id: undefined }))
  })

  it('shows the empty state and the truncation note', async () => {
    mockGetSystemLogs.mockResolvedValue(complete([], { truncated: true }))
    renderPanel()

    expect(await screen.findByText('No errors in this period')).toBeInTheDocument()
    expect(screen.getByText('Showing the newest 10,000 log lines')).toBeInTheDocument()
  })

  it('shows a notice when the search failed, never the route text', async () => {
    mockGetSystemLogs.mockResolvedValue({ status: 'failed', message: 'internal detail', groups: [] })
    renderPanel()

    expect(await screen.findByRole('alert')).toHaveTextContent('The log search failed. Try again.')
    expect(screen.queryByText(/internal detail/)).toBeNull()
  })

  it('reads a running answer without a query id as failed (nothing to poll)', async () => {
    mockGetSystemLogs.mockResolvedValue({ status: 'running', groups: [] })
    renderPanel()

    expect(await screen.findByRole('alert')).toHaveTextContent('The log search failed. Try again.')
    expect(mockGetSystemLogs).toHaveBeenCalledTimes(1)
  })

  it('shows a load error when the request itself fails', async () => {
    mockGetSystemLogs.mockRejectedValue(new Error('API Error: 500'))
    renderPanel()

    expect(await screen.findByRole('alert')).toHaveTextContent('System logs could not be loaded.')
  })

  it('shows an admin-only notice to a non-admin and never queries', () => {
    auth.isAdmin = false
    renderPanel()

    expect(screen.getByRole('alert')).toHaveTextContent('System errors are visible to administrators only.')
    expect(mockGetSystemLogs).not.toHaveBeenCalled()
  })

  it('keeps the well-formed groups of a partly drifted answer', async () => {
    mockGetSystemLogs.mockResolvedValue(complete([AVATAR_GROUP, 'garbage', { ...TIMEOUT_GROUP, level: 'TRACE', count: 'x' }]))
    renderPanel()

    expect(await screen.findByText('projects-assist')).toBeInTheDocument()
    // An unknown level reads as ERROR and a bad count as 1; the string row is dropped.
    expect(screen.getAllByText('ERROR')).toHaveLength(2)
    expect(screen.getByText('chat-stream')).toBeInTheDocument()
  })
})
