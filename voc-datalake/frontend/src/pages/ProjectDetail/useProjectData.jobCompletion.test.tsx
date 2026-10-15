/**
 * A completed job refetches the project, not just the jobs list.
 *
 * `handleJobStarted` invalidates only `projectJobsKey`, which is right — at that
 * moment there is nothing new to read. The documents arrive later, when the job
 * finishes, and a separate effect in `useProjectData` invalidates `projectKey` for
 * any job that completed in the last ten seconds.
 *
 * That effect had no test, and it has just acquired a visible consumer: the
 * Overview prototype card reports "Prototypes built: N" off `data.documents`, so if
 * this stops firing the card silently understates the count until the next window
 * focus or manual reload — the kind of wrong number that is indistinguishable from
 * a build that never ran.
 *
 * Fake timers are deliberately NOT used here: the effect reads `Date.now()` against
 * `completed_at` and needs no clock control, and fake timers in this suite have
 * leaked across files before (see the note in useProjectData.test.ts).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import { useProjectData } from './useProjectData'
import type { ProjectDocument, ProjectJob } from '../../api/types'

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

const prototypeDoc: ProjectDocument = {
  document_id: 'doc-1',
  title: 'Prototype',
  content: '',
  document_type: 'prototype',
  created_at: new Date().toISOString(),
}

// No `as ProjectJob` on a partial literal: the sibling prototype-card test argues
// against exactly that in its own header, and a cast is what stops telling the truth
// once the type gains a field.
const job = (status: ProjectJob['status'], completedAt: string | undefined): ProjectJob => ({
  job_id: 'job-1',
  job_type: 'build_prototype',
  status,
  progress: status === 'completed' ? 100 : 0,
  created_at: new Date().toISOString(),
  completed_at: completedAt,
})

let queryClient: QueryClient

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)

const renderProjectData = () => renderHook(
  () => useProjectData({ id: 'proj-1', apiEndpoint: 'https://api.example.test' }),
  { wrapper },
)

/**
 * Asserted as a second `getProject` call rather than by spying on
 * `invalidateQueries`, for two reasons: it is the outcome that actually matters
 * (fresh documents reach the card), and a `vi.spyOn` on that method cannot be
 * annotated without fighting its generic — the sibling
 * `useProjectData.prototypeRefresh.test.tsx` carries exactly that type error today.
 *
 * Sound here because nothing else refetches the project in this fixture: the
 * document has no `prototype_url`, so the re-sign timer never arms.
 */
const PROJECT_FETCHES_ON_MOUNT = 1

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  getProject.mockResolvedValue({
    project: { project_id: 'proj-1', name: 'P' },
    personas: [],
    documents: [prototypeDoc],
  })
  getProductContext.mockResolvedValue({ context: {} })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('project refetch on job completion', () => {
  it('refetches the project when a build completed moments ago', async () => {
    getJobs.mockResolvedValue({ jobs: [job('completed', new Date().toISOString())] })

    renderProjectData()

    await waitFor(() => expect(getProject.mock.calls.length)
      .toBeGreaterThan(PROJECT_FETCHES_ON_MOUNT))
  })

  it('does not refetch the project for a job that finished long ago', async () => {
    // Otherwise every mount of a project with any historical job would refetch,
    // and the ten-second window would not be doing anything.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    getJobs.mockResolvedValue({ jobs: [job('completed', twoHoursAgo)] })

    renderProjectData()

    await waitFor(() => expect(getJobs).toHaveBeenCalled())
    expect(getProject).toHaveBeenCalledTimes(PROJECT_FETCHES_ON_MOUNT)
  })

  it('does not refetch the project while the build is still running', async () => {
    getJobs.mockResolvedValue({ jobs: [job('running', undefined)] })

    renderProjectData()

    await waitFor(() => expect(getJobs).toHaveBeenCalled())
    expect(getProject).toHaveBeenCalledTimes(PROJECT_FETCHES_ON_MOUNT)
  })
})
