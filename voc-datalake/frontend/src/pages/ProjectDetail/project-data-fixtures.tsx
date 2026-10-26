/**
 * @fileoverview Spec support for the `useProjectData` hook specs.
 *
 * Both hook specs mock the same three `projectsApi` reads and render the hook
 * under a per-test QueryClient. The mocks and the render helper live here; the
 * QueryClient stays in each spec because they spy on it differently.
 *
 * Imports no component or hook on purpose: the specs' `vi.mock` factories call
 * `projectDataApiModule`, so this module must be evaluated before the hook
 * module (and its `projectsApi` import) is. The hook is passed in by the spec.
 */
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { unknownFn } from './project-detail-fixtures'
import type { ProjectDocument } from '../../api/types'

/** The `projectsApi` reads `useProjectData` performs on mount. */
export const projectDataMocks = {
  getProject: unknownFn(),
  getJobs: unknownFn(),
  getProductContext: unknownFn(),
}

/** `vi.mock('../../api/projectsApi', () => projectDataApiModule())` */
export function projectDataApiModule() {
  return {
    projectsApi: {
      getProject: (...args: unknown[]) => projectDataMocks.getProject(...args),
      getJobs: (...args: unknown[]) => projectDataMocks.getJobs(...args),
      getProductContext: (...args: unknown[]) => projectDataMocks.getProductContext(...args),
    },
  }
}

/** The `getProject` payload for project `proj-1` holding exactly `documents`. */
export function projectPayload(documents: ProjectDocument[]) {
  return {
    project: { project_id: 'proj-1', name: 'P' },
    personas: [],
    documents,
  }
}

/** The id and endpoint every hook spec renders with. */
export const PROJECT_DATA_ARGS = { id: 'proj-1', apiEndpoint: 'https://api.example.test' }

/** Renders `useHook()` under `queryClient`, the way both hook specs mount `useProjectData`. */
export function renderWithQueryClient<T>(queryClient: QueryClient, useHook: () => T) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(useHook, { wrapper })
}
