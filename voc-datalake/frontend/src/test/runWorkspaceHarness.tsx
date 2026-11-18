/**
 * @fileoverview The run workspace's spec harness (7.51.00): the shared fixture's exchanges (item B's, in this
 * folder: the API's own answers, held to the real routes by the Python side) as routes of the
 * `fetchApi` double, and the workspace mounted at an address in a memory router (so a spec reads where it moved to).
 *
 * A spec wires `@test/fetchApiRoutes` in first (`vi.mock` of `api/client` and `store/authStore`), then imports this.
 */
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import RunWorkspace from '../pages/Agents/RunWorkspace/RunWorkspace'
import { renderWithQueryClient } from './query-client'
import { fetchApi, routeFetchApi } from './fetchApiRoutes'
import fixture from './engineeringRunWorkspace.json'
import type { RouteHandler } from './fetchApiRoutes'

const RUN = fixture.run_id
export const AGENT = fixture.agent
export const RUN_PATH = `/agents/engineering/${RUN}`
/** (7.51.04) The run at a person whose orchestrator failed at its checkout, and that orchestrator. */
export const FAILED_PATH = `/agents/engineering/${fixture.failed_run_id}`
export const FAILED_ORCHESTRATOR = 'coordinator-1'
const EMPTY_THREAD = { items: [], next: null, done: false }
const NO_GATE = { key: null, record: null, checks: [], passed: null, packs: [], ran_at: null }

/** An exchange's endpoint as the SPA calls `fetchApi` with it: its path and its query. */
export function endpointOf(exchange: { path: string; query?: Record<string, string> }, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ ...exchange.query, ...extra }).toString()
  return query === '' ? exchange.path : `${exchange.path}?${query}`
}

const threadOf = (agent: string) => `${RUN_PATH}/agents/${agent}/thread`

/** The fixture's live run, its fixer's thread (two pages, then nothing new), changes, files, gate, memory, assertions;
 * (7.51.04) the failed run's overview and its orchestrator's thread. */
export function workspaceRoutes(extra: Record<string, RouteHandler> = {}): void {
  routeFetchApi({
    [`GET ${RUN_PATH}`]: () => fixture.overview.answer,
    [`GET ${threadOf(AGENT)}?limit=200`]: () => fixture.thread.answer,
    [`GET ${threadOf(AGENT)}?${new URLSearchParams({ after: fixture.thread.answer.next, limit: '200' }).toString()}`]: () => fixture.thread_next.answer,
    [`GET ${threadOf(AGENT)}?${new URLSearchParams({ after: fixture.thread_next.answer.next, limit: '200' }).toString()}`]:
      () => ({ ...EMPTY_THREAD, next: fixture.thread_next.answer.next }),
    [`GET ${threadOf('coordinator-1')}?limit=200`]: () => EMPTY_THREAD,
    [`GET ${threadOf('gate-runner-4')}?limit=200`]: () => EMPTY_THREAD,
    [`GET ${endpointOf(fixture.thread_item)}`]: () => fixture.thread_item.answer,
    [`GET ${endpointOf(fixture.changes)}`]: () => fixture.changes.answer,
    [`GET ${endpointOf(fixture.change_file)}`]: () => fixture.change_file.answer,
    [`GET ${endpointOf(fixture.files)}`]: () => fixture.files.answer,
    [`GET ${endpointOf(fixture.gate)}`]: () => fixture.gate.answer,
    [`GET ${RUN_PATH}/agents/${AGENT}/gate`]: () => NO_GATE,
    [`GET ${endpointOf(fixture.memory)}`]: () => fixture.memory.answer,
    [`GET ${endpointOf(fixture.assertions)}`]: () => fixture.assertions.answer,
    [`GET ${RUN_PATH}/board`]: () => ({ tasks: [] }),
    [`GET ${RUN_PATH}/conversation?after=0`]: () => ({ items: [], next_after: 0 }),
    [`GET ${RUN_PATH}/reports`]: () => ({ items: [] }),
    [`GET ${FAILED_PATH}`]: () => fixture.failed_overview.answer,
    [`GET ${endpointOf(fixture.failed_thread)}`]: () => fixture.failed_thread.answer,
    [`GET ${FAILED_PATH}/conversation?after=0`]: () => ({ items: [], next_after: 0 }),
    ...extra,
  })
}

/** The workspace at `path`; the router says where it moved to. */
export function renderWorkspace(path: string) {
  const router = createMemoryRouter([
    { path: '/agents/engineering/:runId/*', element: <RunWorkspace /> },
    { path: '/agents/runs', element: <p>Runs</p> },
  ], { initialEntries: [path] })
  renderWithQueryClient(<RouterProvider router={router} />)
  return router
}

/** The endpoints `fetchApi` was called with by `method` (GET by default). */
export function calledEndpoints(method = 'GET'): string[] {
  return fetchApi.mock.calls.filter(([, options]) => (options?.method ?? 'GET') === method).map(([endpoint]) => endpoint)
}
