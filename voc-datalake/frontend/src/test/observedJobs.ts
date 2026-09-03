/**
 * @fileoverview Wait until a hook has actually OBSERVED a jobs payload, not
 * merely requested one.
 *
 * Load-bearing rather than convenience, and the reason it lives here rather than
 * being copied per-suite. `waitFor(() => expect(getJobs).toHaveBeenCalled())`
 * returns as soon as the request is ISSUED, so a test that re-points its mock
 * straight after it can make the post-transition payload the FIRST one the hook
 * ever sees. `useProjectData`'s terminal-job effect correctly only seeds on that
 * first payload — so the invalidation never fires, the assertion holds for the
 * wrong reason, and the test is pinning nothing.
 *
 * Reading the query cache is what closes that gap: an entry is only there once
 * the response has been committed to it.
 *
 * Two suites needed the identical helper (`useProjectData.jobCompletion` and
 * `ProjectDetail.jobHandover`), and the explanation above only lived in one of
 * them — which is exactly the copy that goes stale.
 */
import { waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { expect } from 'vitest'
import { projectJobsKey } from '../pages/ProjectDetail/useProjectData'

/**
 * The job statuses this query client holds for a project, in payload order.
 *
 * Typed structurally rather than as `ProjectJob[]`: callers assert on statuses
 * alone, and a narrower read means a fixture that omits unrelated required
 * fields still works here.
 */
export function observedJobStatuses(
  queryClient: QueryClient, projectId: string,
): string[] {
  const data = queryClient.getQueryData(projectJobsKey(projectId)) as
    { jobs?: readonly { status: string }[] } | undefined
  return (data?.jobs ?? []).map((entry) => entry.status)
}

/** Wait until the hook has observed exactly these job statuses. */
export function awaitObservedJobStatuses(
  queryClient: QueryClient, projectId: string, statuses: readonly string[],
): Promise<void> {
  return waitFor(() => {
    expect(observedJobStatuses(queryClient, projectId)).toEqual(statuses)
  })
}
