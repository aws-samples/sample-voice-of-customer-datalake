/**
 * @fileoverview The `projectsApi` slice the whole ProjectDetail page reads, as one
 * shared set of mocks, for the specs that mount the page.
 *
 * Usage (the factory imports this module, so it must import no component):
 *
 *   vi.mock('../../api/projectsApi', () => import('./page-api-fixtures').then((m) => ({ projectsApi: m.pageApi })))
 *   import { pageApi as api, stubPageReads } from './page-api-fixtures'
 *
 * @module pages/ProjectDetail/page-api-fixtures
 */
import { vi } from 'vitest'
import { useConfigStore } from '../../store/configStore'
import { emptyProductContext } from './productContextFields'

/** One object rather than a mock per method: the specs reach only a few by name. */
export const pageApi = {
  getProject: vi.fn(),
  getJobs: vi.fn(),
  getProductContext: vi.fn(),
  listProductDocs: vi.fn(),
  getProjectMembers: vi.fn(() => new Promise(() => {})),
  dismissJob: vi.fn(),
  updateProject: vi.fn(),
}

/** The page only queries once an endpoint is configured; the store persists across tests. */
export function configureApiEndpoint(): void {
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com/v1' } }))
}

/** Clears every mock and answers the side reads (jobs, product context, docs) with `jobs`. */
export function stubPageReads(jobs: readonly unknown[] = []): void {
  vi.clearAllMocks()
  pageApi.getJobs.mockResolvedValue({ jobs })
  pageApi.getProductContext.mockResolvedValue({ context: emptyProductContext() })
  pageApi.listProductDocs.mockResolvedValue({ docs: [] })
}
