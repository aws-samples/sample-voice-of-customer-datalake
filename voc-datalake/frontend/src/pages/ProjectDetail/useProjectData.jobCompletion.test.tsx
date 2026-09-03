/**
 * A job REACHING a terminal state refetches the project, not just the jobs list.
 *
 * `handleJobStarted` invalidates only `projectJobsKey`, which is right — at that
 * moment there is nothing new to read. The documents arrive later, when the job
 * finishes, and a separate effect in `useProjectData` invalidates `projectKey` on
 * the transition.
 *
 * It is a TRANSITION and not a `completed_at` window, which is what this file's
 * cases now pin. The window compared the writer's clock against the browser's, so a
 * poll landing a second late skipped the refresh and left the Overview prototype
 * card understating "Prototypes built: N" until a manual reload — a wrong number
 * indistinguishable from a build that never ran. It also ignored `failed`, so a
 * failed build left the "generating" affordances lit.
 *
 * Fake timers are deliberately NOT used here: the effect compares payloads and needs
 * no clock control, and fake timers in this suite have leaked across files before
 * (see the note in useProjectData.test.ts).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest'
import {
  firstPayloadMissesAnArtifact, JOB_START_POLL_WINDOW_MS, jobsPollInterval,
  newlyTerminalJobIds, projectJobsKey, useProjectData,
} from './useProjectData'
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
const job = (
  status: ProjectJob['status'],
  completedAt: string | undefined,
  jobId = 'job-1',
): ProjectJob => ({
  job_id: jobId,
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

/** The statuses the hook has actually OBSERVED, not merely those it requested. */
const observedJobStatuses = () => (
  (queryClient.getQueryData(projectJobsKey('proj-1')) as
    { jobs?: readonly ProjectJob[] } | undefined)?.jobs ?? []
).map((entry) => entry.status)

/**
 * Wait until the hook has observed exactly these job statuses.
 *
 * Load-bearing rather than convenience: `waitFor(() => expect(getJobs)
 * .toHaveBeenCalled())` returns as soon as the request is ISSUED, so re-pointing
 * the mock straight after it can make the FIRST payload the hook ever sees the
 * post-transition one — which the seeding rule correctly ignores, and the test
 * would then be asserting nothing.
 */
const awaitObserved = (statuses: readonly ProjectJob['status'][]) =>
  waitFor(() => expect(observedJobStatuses()).toEqual(statuses))

/**
 * Read the jobs list again, the way `handleJobStarted` and the poll both do.
 *
 * Invalidating rather than waiting out `JOB_POLL_INTERVAL_MS`: the three-second
 * cadence is not what any case here is about, and waiting for it would put every
 * assertion past `waitFor`'s default timeout. Fake timers are ruled out by this
 * file's header.
 */
const pollJobsAgain = async (expected: readonly ProjectJob['status'][]) => {
  await queryClient.invalidateQueries({ queryKey: projectJobsKey('proj-1') })
  await awaitObserved(expected)
}

describe('project refetch on terminal job transitions', () => {
  it('refetches the project when a running build turns completed', async () => {
    getJobs.mockResolvedValue({ jobs: [job('running', undefined)] })
    renderProjectData()
    await awaitObserved(['running'])

    getJobs.mockResolvedValue({ jobs: [job('completed', new Date().toISOString())] })
    await pollJobsAgain(['completed'])

    await waitFor(() => expect(getProject.mock.calls.length)
      .toBeGreaterThan(PROJECT_FETCHES_ON_MOUNT))
  })

  it('refetches the project when a running build turns failed', async () => {
    // The window rule never fired for `failed`, so the page kept its "generating"
    // affordances lit and its counts stale until a manual reload.
    getJobs.mockResolvedValue({ jobs: [job('running', undefined)] })
    renderProjectData()
    await awaitObserved(['running'])

    getJobs.mockResolvedValue({ jobs: [job('failed', new Date().toISOString())] })
    await pollJobsAgain(['failed'])

    await waitFor(() => expect(getProject.mock.calls.length)
      .toBeGreaterThan(PROJECT_FETCHES_ON_MOUNT))
  })

  it('refetches when a completion is only observed after the ten-second window', async () => {
    // The defect this replaces: `completed_at` compared against the browser clock.
    // A poll landing late, or a browser clock behind the writer's, skipped it.
    getJobs.mockResolvedValue({ jobs: [job('running', undefined)] })
    renderProjectData()
    await awaitObserved(['running'])

    const longAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    getJobs.mockResolvedValue({ jobs: [job('completed', longAgo)] })
    await pollJobsAgain(['completed'])

    await waitFor(() => expect(getProject.mock.calls.length)
      .toBeGreaterThan(PROJECT_FETCHES_ON_MOUNT))
  })

  it('reports each of two concurrent jobs as it settles', async () => {
    getJobs.mockResolvedValue({
      jobs: [job('running', undefined, 'job-1'), job('running', undefined, 'job-2')],
    })
    renderProjectData()
    await awaitObserved(['running', 'running'])

    getJobs.mockResolvedValue({
      jobs: [
        job('completed', new Date().toISOString(), 'job-1'),
        job('running', undefined, 'job-2'),
      ],
    })
    await pollJobsAgain(['completed', 'running'])
    await waitFor(() => expect(getProject.mock.calls.length)
      .toBe(PROJECT_FETCHES_ON_MOUNT + 1))

    getJobs.mockResolvedValue({
      jobs: [
        job('completed', new Date().toISOString(), 'job-1'),
        job('failed', new Date().toISOString(), 'job-2'),
      ],
    })
    await pollJobsAgain(['completed', 'failed'])

    await waitFor(() => expect(getProject.mock.calls.length)
      .toBe(PROJECT_FETCHES_ON_MOUNT + 2))
  })

  it('does not refetch on mount for a project whose jobs already finished', async () => {
    // Otherwise every project open pays a second project read for history the
    // mount fetch already reflects.
    getJobs.mockResolvedValue({ jobs: [job('completed', new Date().toISOString())] })

    renderProjectData()

    await waitFor(() => expect(getJobs).toHaveBeenCalled())
    expect(getProject).toHaveBeenCalledTimes(PROJECT_FETCHES_ON_MOUNT)
  })

  it('refetches on mount when the first jobs payload names a document the project lacks', async () => {
    // The interleaving seeding alone would drop: `projectKey` and `projectJobsKey`
    // are independent queries, so a job can settle BETWEEN the project read
    // committing server-side and the jobs read committing. Seeding on that payload
    // suppresses the only invalidation this job will ever get — its id is already
    // settled, so the next poll reports no transition, and once nothing is live the
    // poll stops. The page then holds stale Overview counts and a disabled prototype
    // action until a manual action.
    getJobs.mockResolvedValue({
      jobs: [{
        ...job('completed', new Date().toISOString()),
        result: { document_id: 'doc-2', title: 'Prototype (v2)' },
      }],
    })

    renderProjectData()

    // The mount project fetch returns only `doc-1`, so `doc-2` is the artifact it
    // missed.
    await waitFor(() => expect(getProject.mock.calls.length)
      .toBe(PROJECT_FETCHES_ON_MOUNT + 1))
  })

  it('does not refetch on mount when the first payload names a document the project has', async () => {
    // The control for the case above, and the one that keeps the common path at one
    // read: the same shape of payload, differing only in whether the mount fetch
    // already contains the artifact.
    getJobs.mockResolvedValue({
      jobs: [{
        ...job('completed', new Date().toISOString()),
        result: { document_id: prototypeDoc.document_id, title: 'Prototype' },
      }],
    })

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

  it('does not refetch again while a settled job stays settled', async () => {
    getJobs.mockResolvedValue({ jobs: [job('running', undefined)] })
    renderProjectData()
    await awaitObserved(['running'])

    getJobs.mockResolvedValue({ jobs: [job('completed', new Date().toISOString())] })
    await pollJobsAgain(['completed'])
    await waitFor(() => expect(getProject.mock.calls.length)
      .toBe(PROJECT_FETCHES_ON_MOUNT + 1))

    await pollJobsAgain(['completed'])

    expect(getProject).toHaveBeenCalledTimes(PROJECT_FETCHES_ON_MOUNT + 1)
  })
})

describe('newlyTerminalJobIds', () => {
  it('returns a job the caller has not seen settle', () => {
    const seen = new Set<string>()

    expect(newlyTerminalJobIds([job('completed', undefined, 'a')], seen)).toEqual(['a'])
    expect(seen.has('a')).toBe(true)
  })

  it('returns nothing the second time the same job is reported settled', () => {
    const seen = new Set<string>()
    const jobs = [job('failed', undefined, 'a')]

    newlyTerminalJobIds(jobs, seen)

    expect(newlyTerminalJobIds(jobs, seen)).toEqual([])
  })

  it('forgets a settled job that went back to running so its next finish counts', () => {
    // `claim_job_execution` moves a failed row back to `running` on redelivery.
    const seen = new Set<string>()
    newlyTerminalJobIds([job('failed', undefined, 'a')], seen)
    newlyTerminalJobIds([job('running', undefined, 'a')], seen)

    expect(newlyTerminalJobIds([job('completed', undefined, 'a')], seen)).toEqual(['a'])
  })

  it('ignores an entry with no usable job id', () => {
    expect(newlyTerminalJobIds([job('completed', undefined, '')], new Set())).toEqual([])
  })
})

describe('firstPayloadMissesAnArtifact', () => {
  const withResult = (
    result: ProjectJob['result'], status: ProjectJob['status'] = 'completed',
  ): ProjectJob => ({ ...job(status, new Date().toISOString()), result })
  const project = {
    documents: [{ document_id: 'doc-1' }],
    personas: [{ persona_id: 'persona-1' }],
  }

  it('is true for a completed job whose document is not in the project payload', () => {
    expect(firstPayloadMissesAnArtifact([withResult({ document_id: 'doc-2' })], project))
      .toBe(true)
  })

  it('is false when the project payload already contains the document', () => {
    expect(firstPayloadMissesAnArtifact([withResult({ document_id: 'doc-1' })], project))
      .toBe(false)
  })

  it('is true for a completed job whose persona is not in the project payload', () => {
    expect(firstPayloadMissesAnArtifact([withResult({ persona_id: 'persona-2' })], project))
      .toBe(true)
  })

  it('is false when the project payload already contains the persona', () => {
    expect(firstPayloadMissesAnArtifact([withResult({ persona_id: 'persona-1' })], project))
      .toBe(false)
  })

  it('is false while the project read is still in flight', () => {
    // Whatever that read returns will already include the artifact, so there is
    // nothing to invalidate — and invalidating a query that has never resolved
    // would refetch it twice on every open.
    expect(firstPayloadMissesAnArtifact([withResult({ document_id: 'doc-2' })], undefined))
      .toBe(false)
  })

  it('is false for a failed job, which produced no artifact to compare', () => {
    // Its own effect on the page — turning the "generating" affordances off — comes
    // from the jobs payload being read here, not from the project.
    expect(firstPayloadMissesAnArtifact(
      [withResult({ document_id: 'doc-2' }, 'failed')], project,
    )).toBe(false)
  })

  it('is false for a completed job whose result names nothing', () => {
    // The honest answer rather than a refetch on every open: `generate_personas`
    // reports its personas in `result.personas`, and an empty envelope names no
    // artifact at all.
    expect(firstPayloadMissesAnArtifact([withResult({}), withResult(undefined)], project))
      .toBe(false)
  })

  it('is false for a still-running job even when its result names a stale id', () => {
    expect(firstPayloadMissesAnArtifact(
      [withResult({ document_id: 'doc-2' }, 'running')], project,
    )).toBe(false)
  })
})

describe('jobsPollInterval', () => {
  it('stops polling once no live job remains and the start window has closed', () => {
    const started = 1_000
    expect(jobsPollInterval(
      [{ status: 'completed' }, { status: 'failed' }],
      started,
      started + JOB_START_POLL_WINDOW_MS,
    )).toBe(0)
  })

  it('keeps polling while any job is running or pending', () => {
    expect(jobsPollInterval([{ status: 'completed' }, { status: 'pending' }], null, 0))
      .toBeGreaterThan(0)
  })
})
