/**
 * @fileoverview A routed `fetchApi` double for specs that mount pages against
 * a mocked `api/client`.
 *
 * `vi.mock` is hoisted above imports, so a spec wires the double in through a
 * dynamic import inside the factory, then imports the same instance statically
 * to program and inspect it:
 *
 * ```ts
 * vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
 * import { fetchApi, routeFetchApi } from '@test/fetchApiRoutes'
 * ```
 *
 * `store/authStore` is wired the same way through {@link authStoreModule}.
 * Each spec file gets its own module registry, so the doubles are per file.
 */
import { afterAll, beforeAll, vi } from 'vitest'
import { useConfigStore } from '../store/configStore'

/** One canned endpoint: receives the parsed JSON body, returns the response. */
export type RouteHandler = (body: unknown) => unknown

/** The mocked `fetchApi(endpoint, options)`. */
export const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()

/** An `api/client` module whose `fetchApi` delegates to {@link fetchApi}. */
export function fetchApiClientModule() {
  return { fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }
}

/** The real `api/client` module with only `fetchApi` replaced by {@link fetchApi}. */
export async function clientWithMockedFetchApi(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, ...fetchApiClientModule() }
}

/** What the mocked `useIsAdmin()` answers; a spec sets it per test. */
export const adminFlag = { isAdmin: true }

/** A `store/authStore` module whose `useIsAdmin` reads {@link adminFlag}. */
export function authStoreModule() {
  return { useIsAdmin: () => adminFlag.isAdmin }
}

interface RouteOptions {
  /** The `API Error: <status>` an unrouted request rejects with (default 404). */
  missStatus?: number
  /** Match on the path alone, ignoring a `?query` (default false). */
  ignoreQuery?: boolean
}

/**
 * Answer `fetchApi` from `routes`, keyed `"<METHOD> <endpoint>"`. An unrouted
 * request, or a handler that throws, rejects like the real client.
 */
export function routeFetchApi(routes: Record<string, RouteHandler>, { missStatus = 404, ignoreQuery = false }: RouteOptions = {}): void {
  fetchApi.mockImplementation((endpoint, options) => {
    const path = ignoreQuery ? endpoint.split('?')[0] : endpoint
    const key = `${options?.method ?? 'GET'} ${path}`
    const handler = Object.hasOwn(routes, key) ? routes[key] : undefined
    if (handler === undefined) return Promise.reject(new Error(`API Error: ${missStatus}`))
    const body: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined
    try {
      return Promise.resolve(handler(body))
    } catch (error) {
      return Promise.reject(error)
    }
  })
}

/** Per-test reset: forget every programmed answer and point the SPA at an API. */
export function resetFetchApi(): void {
  fetchApi.mockReset()
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com' } }))
}

/** React Flow constructs a ResizeObserver per node; the shared setup's mock is not constructible. */
class ResizeObserverStub {
  observe(): void { /* jsdom has no layout */ }
  unobserve(): void { /* jsdom has no layout */ }
  disconnect(): void { /* jsdom has no layout */ }
}

/** Stub a constructible ResizeObserver for the calling suite (React Flow canvases). */
export function stubResizeObserverForSuite(): void {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })
}
