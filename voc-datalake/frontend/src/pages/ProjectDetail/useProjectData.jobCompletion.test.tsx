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
import { QueryClient } from '@tanstack/react-query'
import { waitFor } from '@testing-library/react'
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import {
  PROJECT_DATA_ARGS, projectDataApiModule, projectDataMocks, projectPayload, renderWithQueryClient,
} from './project-data-fixtures'
// After the fixtures on purpose: the hook imports the mocked `projectsApi`, whose
// `vi.mock` factory below needs the fixture module evaluated first.
import { useProjectData } from './useProjectData'
import type { ProjectDocument } from '../../api/types'
import type { ProjectJob } from '../../api/projectTypes'

vi.mock('../../api/projectsApi', () => projectDataApiModule())
const { getProject, getJobs, getProductContext } = projectDataMocks

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

/** Mounts the hook on a fresh client, so no cache outlives the test that made it. */
const renderProjectData = () => renderWithQueryClient(
  new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  () => useProjectData(PROJECT_DATA_ARGS),
)

/**
 * Asserted as a second `getProject` call rather than by spying on
 * `invalidateQueries`, for two reasons: it is the outcome that actually matters
 * (fresh documents reach the card), and it needs no spy on the client's internals.
 *
 * Sound here because nothing else refetches the project in this fixture: the
 * document has no `prototype_url`, so the re-sign timer never arms.
 */
const PROJECT_FETCHES_ON_MOUNT = 1

beforeEach(() => {
  getProject.mockResolvedValue(projectPayload([prototypeDoc]))
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

    await waitFor(() => expect(getJobs).toHaveBeenCalledWith('proj-1'))
    expect(getProject).toHaveBeenCalledTimes(PROJECT_FETCHES_ON_MOUNT)
  })

  it('does not refetch the project while the build is still running', async () => {
    getJobs.mockResolvedValue({ jobs: [job('running', undefined)] })

    renderProjectData()

    await waitFor(() => expect(getJobs).toHaveBeenCalledWith('proj-1'))
    expect(getProject).toHaveBeenCalledTimes(PROJECT_FETCHES_ON_MOUNT)
  })
})
