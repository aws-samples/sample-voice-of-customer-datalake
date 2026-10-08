/**
 * @fileoverview Helpers for specs that drive the real API client against a
 * stubbed `global.fetch`.
 *
 * The client only reads `ok`, `status` and `json()` from a response, so the
 * stubs below are those partial objects. `fetchMock()` narrows `global.fetch`
 * with `vi.isMockFunction` rather than a cast, so a spec that forgot to install
 * the stub fails with a message instead of calling the network.
 */
import { expect, vi, type Mock } from 'vitest'

/** The parts of a `RequestInit` the API specs assert on. */
interface RecordedInit {
  headers?: Record<string, string>
  body?: string
  method?: string
}

function isRecordedInit(value: unknown): value is RecordedInit {
  return typeof value === 'object' && value !== null
}

/** The stub the last `installFetchMock()` put in place. */
const stub: { installed?: Mock } = {}

/** Replace `global.fetch` with a fresh `vi.fn()` and return it. */
export function installFetchMock(): Mock {
  const mock = vi.fn()
  stub.installed = mock
  // `stubGlobal` rather than `global.fetch = mock`: the stub is deliberately a
  // partial `fetch` (see the module note), which plain assignment rejects.
  vi.stubGlobal('fetch', mock)
  return mock
}

/** The currently installed `global.fetch` stub. */
export function fetchMock(): Mock {
  // Identity, not `vi.isMockFunction`: that narrows to `typeof fetch`, whose
  // signature rejects the partial responses these stubs resolve with.
  const { installed } = stub
  if (installed === undefined || global.fetch !== installed) {
    throw new Error('global.fetch is not the installed stub — call installFetchMock() first')
  }
  return installed
}

/** Queue one successful response whose JSON body is `body`. */
export function mockJsonOnce(body: unknown): void {
  fetchMock().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(body) })
}

/** Queue one non-OK response with the given HTTP status. */
export function mockStatusOnce(status: number): void {
  fetchMock().mockResolvedValueOnce({ ok: false, status })
}

/**
 * Queue one non-OK response whose body text is `body` (what the client reads
 * for a server error message). Omit `body` for a response with no `text()`.
 */
export function mockFailureOnce(status: number, body?: string): void {
  fetchMock().mockResolvedValueOnce({
    ok: false,
    status,
    ...(body === undefined ? {} : { text: () => Promise.resolve(body) }),
  })
}

/** `[url, init]` of the fetch call at `index` (the first call by default). */
function fetchCall(index = 0): [string, RecordedInit] {
  const call: unknown[] | undefined = fetchMock().mock.calls.at(index)
  if (!call) throw new Error(`fetch was not called ${String(index + 1)} time(s)`)
  const [url, init] = call
  return [String(url), isRecordedInit(init) ? init : {}]
}

/** The URL of the fetch call at `index`. */
export function requestUrl(index = 0): string {
  return fetchCall(index)[0]
}

/** The request headers of the fetch call at `index` (`{}` when none were sent). */
export function requestHeaders(index = 0): Record<string, string> {
  return fetchCall(index)[1].headers ?? {}
}

/** The JSON-parsed request body of the fetch call at `index`. */
export function requestBody(index = 0): unknown {
  const [, init] = fetchCall(index)
  return JSON.parse(String(init.body))
}

/**
 * Assert that fetch was called with `url` and an init matching `init`
 * (`expect.objectContaining`), or any init when `init` is omitted.
 */
export function expectFetchedWith(url: string, init?: Record<string, unknown>): void {
  expect(global.fetch).toHaveBeenCalledWith(url, init ? expect.objectContaining(init) : expect.any(Object))
}
