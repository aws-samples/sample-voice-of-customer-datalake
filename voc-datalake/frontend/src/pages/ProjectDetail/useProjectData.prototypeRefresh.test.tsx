/**
 * The pre-expiry re-sign actually fires.
 *
 * `refreshDelayMs` and `earliestPrototypeExpiry` are covered as pure functions, but
 * that left a hole: deleting the whole `useEffect` that consumes them kept every other
 * test green. These assert the wiring — that a timer is scheduled, that it invalidates
 * the project query, that it re-arms off the replacement URL, and that it is NOT set
 * when there is no deadline to beat.
 *
 * Fake timers are confined to this file and torn down in `afterEach`, because they have
 * leaked across files in this suite before (see the note in useProjectData.test.ts).
 * The pure arithmetic stays in the other file precisely so this one can be small.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import { useProjectData } from './useProjectData'
import { REFRESH_LEAD_MS } from '../../components/prototypeLinkLifetime'
import type { ProjectDocument } from '../../api/types'

const getProject = vi.fn()
const getJobs = vi.fn()
const getProductContext = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProject: (...args: unknown[]) => getProject(...args),
    getJobs: (...args: unknown[]) => getJobs(...args),
    getProductContext: (...args: unknown[]) => getProductContext(...args),
  },
}))

const HOUR_MS = 60 * 60_000
const PATH = 'https://d1.cloudfront.net/prototypes/proj-1/doc-1.html'

const signed = (expiresAtMs: number, signature: string) =>
  `${PATH}?Expires=${Math.floor(expiresAtMs / 1000)}&Signature=${signature}&Key-Pair-Id=K1`

const prototypeDoc = (prototypeUrl?: string): ProjectDocument => ({
  document_id: 'doc-1',
  title: 'My Prototype',
  content: '',
  document_type: 'prototype',
  prototype_format: 'html',
  prototype_url: prototypeUrl,
  created_at: new Date().toISOString(),
})

const projectPayload = (documents: ProjectDocument[]) => ({
  project: { project_id: 'proj-1', name: 'P' },
  personas: [],
  documents,
})

let queryClient: QueryClient
let invalidateSpy: ReturnType<typeof vi.spyOn>

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)

const renderProjectData = () => renderHook(
  () => useProjectData({ id: 'proj-1', apiEndpoint: 'https://api.example.test' }),
  { wrapper },
)

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
  getJobs.mockResolvedValue({ jobs: [] })
  getProductContext.mockResolvedValue({ context: {} })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

const invalidatedProject = () => invalidateSpy.mock.calls.some(
  ([arg]) => JSON.stringify((arg as { queryKey?: unknown })?.queryKey) === JSON.stringify(['project', 'proj-1']),
)

describe('pre-expiry re-sign', () => {
  it('invalidates the project query before the signature expires', async () => {
    getProject.mockResolvedValue(projectPayload([prototypeDoc(signed(Date.now() + HOUR_MS, 'sig-1'))]))
    const { result } = renderProjectData()
    await waitFor(() => expect(result.current.data).toBeDefined())

    invalidateSpy.mockClear()
    expect(invalidatedProject()).toBe(false)

    // Just past the scheduled moment: one hour of life minus the five-minute lead.
    await act(async () => {
      vi.advanceTimersByTime(HOUR_MS - REFRESH_LEAD_MS + 1000)
    })

    expect(invalidatedProject()).toBe(true)
  })

  it('does not invalidate before the lead time is reached', async () => {
    getProject.mockResolvedValue(projectPayload([prototypeDoc(signed(Date.now() + HOUR_MS, 'sig-1'))]))
    const { result } = renderProjectData()
    await waitFor(() => expect(result.current.data).toBeDefined())

    invalidateSpy.mockClear()
    await act(async () => {
      vi.advanceTimersByTime(HOUR_MS - REFRESH_LEAD_MS - 60_000)
    })

    expect(invalidatedProject()).toBe(false)
  })

  it('schedules nothing for a project whose prototype has no signature', async () => {
    // A legacy prototype is rendered from inline content and has no deadline. A timer
    // here would be a refetch loop with nothing to refresh.
    getProject.mockResolvedValue(projectPayload([prototypeDoc(undefined)]))
    const { result } = renderProjectData()
    await waitFor(() => expect(result.current.data).toBeDefined())

    invalidateSpy.mockClear()
    await act(async () => {
      vi.advanceTimersByTime(4 * HOUR_MS)
    })

    expect(invalidatedProject()).toBe(false)
  })

  it('schedules nothing for a project with no prototype at all', async () => {
    getProject.mockResolvedValue(projectPayload([{
      document_id: 'doc-2',
      title: 'A PRD',
      content: '# H',
      document_type: 'prd',
      created_at: new Date().toISOString(),
    }]))
    const { result } = renderProjectData()
    await waitFor(() => expect(result.current.data).toBeDefined())

    invalidateSpy.mockClear()
    await act(async () => {
      vi.advanceTimersByTime(4 * HOUR_MS)
    })

    expect(invalidatedProject()).toBe(false)
  })

  /**
   * The cycle has to continue for as long as the page is open. If the timer did not
   * re-arm off the replacement URL, a prototype would survive exactly one renewal and
   * then lapse — which looks fine in a short test and fails after two hours in use.
   */
  it('re-arms off the replacement URL so renewal repeats', async () => {
    getProject
      .mockResolvedValueOnce(projectPayload([prototypeDoc(signed(Date.now() + HOUR_MS, 'sig-1'))]))
      .mockResolvedValue(projectPayload([prototypeDoc(signed(Date.now() + 2 * HOUR_MS, 'sig-2'))]))

    const { result } = renderProjectData()
    await waitFor(() => expect(result.current.data).toBeDefined())

    await act(async () => {
      vi.advanceTimersByTime(HOUR_MS - REFRESH_LEAD_MS + 1000)
    })
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2))

    invalidateSpy.mockClear()
    await act(async () => {
      vi.advanceTimersByTime(2 * HOUR_MS)
    })

    expect(invalidatedProject()).toBe(true)
  })
})
