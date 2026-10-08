/**
 * Shared `api/client` double for the category UI tests (the "Change category"
 * control and Settings → Users → Category access): `api.getCategoriesConfig`
 * plus `fetchApi`, which the category-access / category-change APIs call.
 *
 * `vi.mock` factories are hoisted above static imports, so a test obtains the
 * double through `vi.hoisted` and hands its `module` to `vi.mock`:
 *
 *   const client = await vi.hoisted(async () =>
 *     (await import('@test/categoryClientMock')).createCategoryClientMock())
 *   vi.mock('../../api/client', () => client.module)
 */
import { vi } from 'vitest'
import { useConfigStore } from '../store/configStore'

type FetchApi = (endpoint: string, options?: { method?: string; body?: string }) => Promise<unknown>

export function createCategoryClientMock() {
  const fetchApi = vi.fn<FetchApi>()
  const getCategoriesConfig = vi.fn<() => Promise<unknown>>()
  return {
    fetchApi,
    getCategoriesConfig,
    module: {
      api: { getCategoriesConfig: () => getCategoriesConfig() },
      fetchApi: (endpoint: string, options?: { method?: string; body?: string }) => fetchApi(endpoint, options),
    },
  }
}

/** Per-test reset: clear every mock, point the SPA at an API, serve `config` as the categories config. */
export function primeCategoryClient(client: ReturnType<typeof createCategoryClientMock>, config: unknown): void {
  vi.clearAllMocks()
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com' } }))
  client.getCategoriesConfig.mockResolvedValue(config)
}
