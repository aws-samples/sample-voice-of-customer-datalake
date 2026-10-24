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
import { QueryClient } from '@tanstack/react-query'
import { waitFor, act } from '@testing-library/react'
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import {
  PROJECT_DATA_ARGS, projectDataApiModule, projectDataMocks, projectPayload, renderWithQueryClient,
} from './project-data-fixtures'
import { HOUR_MS, signedPrototypeUrl, urlPrototypeDoc as prototypeDoc } from './prototype-fixtures'
// After the fixtures on purpose: the hook imports the mocked `projectsApi`, whose
// `vi.mock` factory below needs the fixture module evaluated first.
import { useProjectData } from './useProjectData'
import { REFRESH_LEAD_MS } from '../../components/prototypeLinkLifetime'
import type { ProjectDocument } from '../../api/types'

vi.mock('../../api/projectsApi', () => projectDataApiModule())
const { getProject, getJobs, getProductContext } = projectDataMocks

const PATH = 'https://d1.cloudfront.net/prototypes/proj-1/doc-1.html'

const signed = (expiresAtMs: number, signature: string) => signedPrototypeUrl(PATH, expiresAtMs, signature)

const PROJECT_KEY = JSON.stringify(['project', 'proj-1'])

/**
 * Mounts the hook on a fresh client whose `invalidateQueries` is observed, so no
 * client or spy outlives the test that made it.
 */
function renderProjectData() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
  const rendered = renderWithQueryClient(queryClient, () => useProjectData(PROJECT_DATA_ARGS))
  const invalidatedProject = () => invalidateSpy.mock.calls.some(
    ([filters]) => JSON.stringify(filters?.queryKey) === PROJECT_KEY,
  )
  return { result: rendered.result, invalidateSpy, invalidatedProject }
}

/** Serves `documents`, mounts the hook, waits for data and forgets the mount-time invalidations. */
async function loadProject(documents: ProjectDocument[]) {
  getProject.mockResolvedValue(projectPayload(documents))
  const { result, invalidateSpy, invalidatedProject } = renderProjectData()
  await waitFor(() => expect(result.current.data).toBeDefined())
  invalidateSpy.mockClear()
  return invalidatedProject
}

/** Moves the fake clock forward inside `act`, so effects scheduled by the hook run. */
async function advanceClock(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  getJobs.mockResolvedValue({ jobs: [] })
  getProductContext.mockResolvedValue({ context: {} })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('pre-expiry re-sign', () => {
  it('invalidates the project query before the signature expires', async () => {
    const invalidatedProject = await loadProject([prototypeDoc(signed(Date.now() + HOUR_MS, 'sig-1'))])
    expect(invalidatedProject()).toBe(false)

    // Just past the scheduled moment: one hour of life minus the five-minute lead.
    await advanceClock(HOUR_MS - REFRESH_LEAD_MS + 1000)

    expect(invalidatedProject()).toBe(true)
  })

  it('does not invalidate before the lead time is reached', async () => {
    const invalidatedProject = await loadProject([prototypeDoc(signed(Date.now() + HOUR_MS, 'sig-1'))])
    await advanceClock(HOUR_MS - REFRESH_LEAD_MS - 60_000)

    expect(invalidatedProject()).toBe(false)
  })

  it('schedules nothing for a project whose prototype has no signature', async () => {
    // A legacy prototype is rendered from inline content and has no deadline. A timer
    // here would be a refetch loop with nothing to refresh.
    const invalidatedProject = await loadProject([prototypeDoc()])
    await advanceClock(4 * HOUR_MS)

    expect(invalidatedProject()).toBe(false)
  })

  it('schedules nothing for a project with no prototype at all', async () => {
    const invalidatedProject = await loadProject([{
      document_id: 'doc-2',
      title: 'A PRD',
      content: '# H',
      document_type: 'prd',
      created_at: new Date().toISOString(),
    }])
    await advanceClock(4 * HOUR_MS)

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

    const { result, invalidateSpy, invalidatedProject } = renderProjectData()
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
