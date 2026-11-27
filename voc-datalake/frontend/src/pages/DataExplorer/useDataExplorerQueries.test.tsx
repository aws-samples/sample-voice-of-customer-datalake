/**
 * Data Explorer → Processed Feedback search runs on the server.
 *
 * Production finding (5.09.00): "checkout" showed 5 of 100 here (a filter over
 * the 100 rows already loaded) while Categories found 9. The search box now
 * calls `/feedback/search`, whose `total` counts every match in the window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryWrapper, createTestQueryClient } from '@test/query-client'
import { JUNIPER } from '@test/workspaceFixtures'
import { useConfigStore } from '../../store/configStore'
import { ApiError } from '../../lib/errors'
import { setCurrentWorkspace, type CurrentWorkspace } from '../../workspace/currentWorkspace'
import { workspacesApi, type ServerWorkspace } from '../../api/workspacesApi'

/** The workspace as `GET /me/workspaces/current` serves it, with the role the server applies there. */
const served = (workspace: CurrentWorkspace): ServerWorkspace => ({ ...workspace, trial: null, playbook: null })

const apiMocks = vi.hoisted(() => ({
  getFeedback: vi.fn(),
  searchFeedback: vi.fn(),
  getDataExplorerBuckets: vi.fn(),
  getDataExplorerS3: vi.fn(),
  getSources: vi.fn(),
}))

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, api: { ...actual.api, ...apiMocks } }
})

import { useDataExplorerQueries } from './useDataExplorerQueries'

const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
  <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
)

const item = (id: string) => ({ feedback_id: id, original_text: `checkout ${id}`, category: 'payments' })

function render(search: string) {
  return renderHook(() => useDataExplorerQueries('dynamodb-processed', 'raw-data', [], '', search), { wrapper })
}

type ExplorerResult = ReturnType<typeof render>['result']

/** Runs *check* on the S3 tab's queries inside JUNIPER (a fresh query client), then leaves the workspace and
 * restores the spies, whatever the check did. */
async function inJuniper(check: (result: ExplorerResult) => Promise<void>) {
  act(() => setCurrentWorkspace(JUNIPER))
  try {
    const { result } = renderHook(() => useDataExplorerQueries('s3-raw', 'raw-data', [], '', ''), { wrapper: createQueryWrapper() })
    await check(result)
  } finally {
    act(() => setCurrentWorkspace(null))
    vi.restoreAllMocks()
  }
}

/** Gives the queries a moment to fire, then holds that neither the listing nor the buckets were asked for. */
async function expectNothingAsked() {
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  expect(apiMocks.getDataExplorerS3).not.toHaveBeenCalled()
  expect(apiMocks.getDataExplorerBuckets).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com' } }))
  apiMocks.getFeedback.mockResolvedValue({ count: 2, total: 40, is_partial_window: false, items: [item('a'), item('b')] })
  apiMocks.searchFeedback.mockResolvedValue({
    count: 2, total: 9, has_more: true, next_token: 't', is_partial_window: false, items: [item('a'), item('b')],
  })
  apiMocks.getSources.mockResolvedValue({ sources: {} })
  apiMocks.getDataExplorerBuckets.mockResolvedValue({ buckets: [] })
})

describe('processed feedback search', () => {
  it('asks the server and reports every match in the window', async () => {
    const { result } = render('  checkout ')

    await waitFor(() => expect(result.current.feedbackData?.total).toBe(9))
    expect(apiMocks.searchFeedback).toHaveBeenCalledWith(expect.objectContaining({ q: 'checkout', limit: 100 }))
    expect(result.current.feedbackData?.isLowerBound).toBe(false)
  })

  it('lists without a search below the two-character minimum', async () => {
    const { result } = render('c')

    await waitFor(() => expect(result.current.feedbackData?.total).toBe(40))
    expect(apiMocks.searchFeedback).not.toHaveBeenCalled()
  })

  it('marks an uncounted search with more pages as a lower bound', async () => {
    apiMocks.searchFeedback.mockResolvedValue({ count: 1, total: null, has_more: true, items: [item('a')] })
    const { result } = render('checkout')

    await waitFor(() => expect(result.current.feedbackData?.isLowerBound).toBe(true))
    expect(result.current.feedbackData?.total).toBe(1)
  })
})

// Live finding: "Showing 100 of 200+" with no way to reach the rest.
describe('processed feedback paging', () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => item(`r${from + i}`))

  /** Render for `search`, wait until a next page is offered, load it and wait for `total` rows. */
  async function loadSecondPage(search: string, total: number) {
    const { result } = render(search)
    await waitFor(() => expect(result.current.feedbackMore.hasMore).toBe(true))
    result.current.feedbackMore.load()
    await waitFor(() => expect(result.current.feedbackData?.items).toHaveLength(total))
    return result
  }

  it('loads the next offset page of the list and appends it', async () => {
    apiMocks.getFeedback
      .mockResolvedValueOnce({ count: 100, total: 200, is_partial_window: true, items: page(0, 100) })
      .mockResolvedValueOnce({ count: 30, total: 130, is_partial_window: false, items: page(100, 30) })
    const result = await loadSecondPage('', 130)

    expect(apiMocks.getFeedback).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 100, limit: 100 }))
    expect({ ...result.current.feedbackData, hasMore: result.current.feedbackMore.hasMore })
      .toMatchObject({ total: 130, isLowerBound: false, hasMore: false })
  })

  it('follows the search cursor for the next page', async () => {
    apiMocks.searchFeedback
      .mockResolvedValueOnce({ count: 2, total: 3, has_more: true, next_token: 'tok', items: [item('a'), item('b')] })
      .mockResolvedValueOnce({ count: 1, total: 3, has_more: false, items: [item('c')] })
    await loadSecondPage('checkout', 3)

    expect(apiMocks.searchFeedback).toHaveBeenLastCalledWith(expect.objectContaining({ next_token: 'tok' }))
  })

  it('does not read the time-scoped source list on the S3 tab', async () => {
    apiMocks.getDataExplorerS3.mockResolvedValue({ objects: [] })
    renderHook(() => useDataExplorerQueries('s3-raw', 'raw-data', [], '', ''), { wrapper })

    await waitFor(() => expect(apiMocks.getDataExplorerS3).toHaveBeenCalledWith('', 'raw-data'))
    expect(apiMocks.getSources).not.toHaveBeenCalled()
  })
})

// Inside a workspace every /data-explorer/* route is for its admins only (lambda/api/data_explorer_handler.py).
describe('who may read the explorer here', () => {
  it('reports a 403 from the API as forbidden, not as a failed listing alone', async () => {
    apiMocks.getDataExplorerS3.mockRejectedValue(new ApiError(403, 'Workspace admin access required'))
    const { result } = renderHook(() => useDataExplorerQueries('s3-raw', 'raw-data', [], '', ''), { wrapper })

    await waitFor(() => expect(result.current.forbidden).toBe(true))
  })

  it('is not forbidden on any other failure', async () => {
    apiMocks.getDataExplorerS3.mockRejectedValue(new ApiError(500))
    const { result } = renderHook(() => useDataExplorerQueries('s3-raw', 'raw-data', [], '', ''), { wrapper })

    await waitFor(() => expect(result.current.s3Failure.loadFailed).toBe(true))
    expect(result.current.forbidden).toBe(false)
  })

  it("asks nothing of the API inside a workspace the caller is not an admin of (its admins only: a 403)", async () => {
    vi.spyOn(workspacesApi, 'current').mockResolvedValue(served(JUNIPER))
    await inJuniper(async (result) => {
      await waitFor(() => expect(result.current.forbidden).toBe(true))
      expect(result.current.roleLoading).toBe(false)
      await expectNothingAsked()
    })
  })

  it('asks nothing and refuses nothing until the server says the role it applies in the workspace', async () => {
    vi.spyOn(workspacesApi, 'current').mockReturnValue(new Promise<ServerWorkspace>(() => {}))
    await inJuniper(async (result) => {
      expect(result.current.roleLoading).toBe(true)
      expect(result.current.forbidden).toBe(false)
      await expectNothingAsked()
    })
  })

  it("reads the explorer for a platform admin whom the membership list calls an editor but the server an admin", async () => {
    vi.spyOn(workspacesApi, 'current').mockResolvedValue(served({ ...JUNIPER, role: 'admin' }))
    apiMocks.getDataExplorerS3.mockResolvedValue({ objects: [], prefix: '' })
    apiMocks.getDataExplorerBuckets.mockResolvedValue({ buckets: [] })
    await inJuniper(async (result) => {
      await waitFor(() => expect(apiMocks.getDataExplorerS3).toHaveBeenCalledWith('', 'raw-data'))
      expect(result.current.forbidden).toBe(false)
      expect(result.current.roleLoading).toBe(false)
    })
  })
})
