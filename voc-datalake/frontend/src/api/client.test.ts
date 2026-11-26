/**
 * @fileoverview Tests for the API client's request pipeline: headers, error
 * bodies, the 401 refresh-and-retry path, query building and the date-range
 * helpers. The per-endpoint URL/method/body round-trips live in
 * `client.endpoints.test.ts`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  expectFetchedWith, fetchMock, installFetchMock, mockFailureOnce, mockJsonOnce, mockStatusOnce,
  requestHeaders, requestUrl,
} from '@test/fetch-mock'

/**
 * Mock defaults, shared between the `vi.mock` factories below and the
 * `beforeEach` that restores them.
 *
 * `vi.hoisted` is what makes the sharing possible: the factories are hoisted
 * above the imports, so a plain module-level `const` would still be in its
 * temporal dead zone when a factory first runs.
 *
 * They have to be restored per-test, not just declared once, because
 * `vi.clearAllMocks()` only drops call history: a test calling
 * `mockReturnValue` on `getRuntimeConfig` would otherwise change the
 * trusted-origin allowlist for every test after it in this file. Every factory
 * mock is a `vi.fn(impl)`, so `mockReset()` puts `impl` back (vitest ≥ 3) —
 * which is what the `beforeEach` relies on, and what the regression guard in
 * "401 handling" checks.
 */
const {
  DEFAULT_ENDPOINT, DEFAULT_ID_TOKEN, DEFAULT_RUNTIME_CONFIG, DEFAULT_STORE_STATE,
} = vi.hoisted(() => {
  const endpoint = 'https://api.example.com'
  return {
    DEFAULT_ENDPOINT: endpoint,
    DEFAULT_ID_TOKEN: 'mock-id-token',
    DEFAULT_RUNTIME_CONFIG: {
      apiEndpoint: endpoint,
      cognito: {
        userPoolId: 'pool-1',
        clientId: 'client-1',
        region: 'us-east-1',
      },
    },
    DEFAULT_STORE_STATE: {
      config: { apiEndpoint: endpoint },
      dateBasis: 'imported',
    },
  }
})

// Mock stores and auth before importing client
vi.mock('../store/configStore', () => ({
  useConfigStore: {
    getState: vi.fn(() => DEFAULT_STORE_STATE),
  },
}))

// The origin-check in baseUrl.ts reads the runtime config to build the
// trusted-origins allowlist. Without this mock, isConfigLoaded() returns
// false, the allowlist is empty, and Authorization is never attached —
// breaking every test that asserts the header is present.
vi.mock('../runtimeConfig', () => ({
  isConfigLoaded: vi.fn(() => true),
  getRuntimeConfig: vi.fn(() => DEFAULT_RUNTIME_CONFIG),
}))

vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(() => true),
    getIdToken: vi.fn(() => DEFAULT_ID_TOKEN),
    refreshSession: vi.fn(() => Promise.resolve(undefined)),
    signOut: vi.fn(),
  },
}))

import { api, fetchApi, getDateRangeParams } from './client'
import { agentsApi } from './agentsApi'
import { workflowDefinitionSchema, workflowsApi } from './workflowsApi'
import type { WorkflowDefinition } from './workflowsApi'
import { MINI_WORKFLOW } from '../test/workflowFixtures'
import { ALL_TIME_CUSTOM_DAYS, getDaysFromRange, MAX_CUSTOM_DAYS, WIDEST_PRESET_DAYS } from './baseUrl'
import { ApiError, apiErrorCode } from '../lib/errors'
import { apiErrorStatus } from './apiErrorStatus'
import { authService } from '../services/auth'
import * as runtimeConfig from '../runtimeConfig'
import { useConfigStore } from '../store/configStore'
import { SESSION_EXPIRED_PATH, resetSessionExpiryForTests } from '../services/sessionExpiry'
import { setCurrentWorkspace } from '../workspace/currentWorkspace'
import { ACME } from '../test/workspaceFixtures'

const EMPTY_PAGE = { count: 0, items: [] }

/** Make the next refresh re-point `getIdToken` at a fresh token, as Cognito does. */
function refreshIssuesFreshToken(): void {
  vi.mocked(authService.refreshSession).mockImplementationOnce(() => {
    vi.mocked(authService.getIdToken).mockReturnValue('fresh-token')
    return Promise.resolve()
  })
}

/** A 401 followed by a successful retry. */
function queueUnauthorizedThenOk(): void {
  mockStatusOnce(401)
  mockJsonOnce(EMPTY_PAGE)
}

/**
 * Stub `window.location` with a spy `replace` (the session-expiry redirect) and
 * re-arm the idempotent redirect. `setup.ts` restores the real location after
 * every test.
 */
function stubLocationReplace() {
  const replace = vi.fn()
  Object.defineProperty(window, 'location', {
    value: { href: '', replace },
    writable: true,
    configurable: true,
  })
  resetSessionExpiryForTests()
  return replace
}

/** The query parameters of the first request, as a plain object. */
function requestedParams(): Record<string, string> {
  return Object.fromEntries(new URL(requestUrl()).searchParams)
}

beforeEach(() => {
  vi.clearAllMocks()
  // Back to the factory implementations (see the note on the defaults).
  vi.mocked(runtimeConfig.isConfigLoaded).mockReset()
  vi.mocked(runtimeConfig.getRuntimeConfig).mockReset()
  vi.mocked(authService.getIdToken).mockReset()
  vi.mocked(authService.refreshSession).mockReset()
  vi.mocked(useConfigStore.getState).mockReset()
  installFetchMock()
})

describe('getFeedback', () => {
  it('fetches feedback with correct query parameters', async () => {
    mockJsonOnce({ count: 2, items: [{ feedback_id: '1' }, { feedback_id: '2' }] })

    const result = await api.getFeedback({ days: 7, source: 'webscraper' })

    expectFetchedWith('https://api.example.com/feedback?days=7&source=webscraper', {
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'Authorization': 'mock-id-token',
      }),
    })
    // Items are normalized to the FeedbackItem contract at the client boundary.
    expect({ count: result.count, ids: result.items.map((i) => i.feedback_id) })
      .toStrictEqual({ count: 2, ids: ['1', '2'] })
  })

  it('throws error on non-ok response', async () => {
    mockStatusOnce(500)

    await expect(api.getFeedback({ days: 7 })).rejects.toThrow('API Error: 500')
  })

  it('includes all filter parameters when provided', async () => {
    mockJsonOnce(EMPTY_PAGE)

    await api.getFeedback({ days: 30, source: 'webscraper', category: 'delivery', sentiment: 'negative', limit: 50 })

    expect(requestedParams()).toMatchObject({
      days: '30', source: 'webscraper', category: 'delivery', sentiment: 'negative', limit: '50',
    })
  })

  it('omits undefined parameters from query string', async () => {
    mockJsonOnce(EMPTY_PAGE)

    await api.getFeedback({ days: 7 })

    expect(requestedParams()).not.toHaveProperty('source')
    expect(requestedParams()).not.toHaveProperty('category')
  })
})

describe('getFeedbackById', () => {
  it('fetches single feedback item by id', async () => {
    mockJsonOnce({ feedback_id: 'abc123', text: 'Test feedback' })

    const result = await api.getFeedbackById('abc123')

    expectFetchedWith('https://api.example.com/feedback/abc123')
    // Response is normalized to the FeedbackItem contract at the client boundary.
    expect(result.feedback_id).toBe('abc123')
  })
})

describe('a body that names a run', () => {
  it('keeps a well-formed `run_id` on the error, and drops one that is not a run id', async () => {
    const RUN = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'
    const caught = async (body: unknown): Promise<unknown> => {
      mockFailureOnce(503, JSON.stringify(body))
      return fetchApi('/agents/engineering/runs').catch((error: unknown) => error)
    }
    const named = await caught({ error: `run ${RUN} may have been started`, run_id: RUN })
    const forged = await caught({ error: 'down', run_id: '../other' })
    expect([named instanceof ApiError && named.runId, forged instanceof ApiError && forged.runId])
      .toStrictEqual([RUN, undefined])
  })
})

describe('a body that names failing checks (an engineering Enable\'s 409, 7.50.00)', () => {
  const caught = async (body: unknown): Promise<unknown> => {
    mockFailureOnce(409, JSON.stringify(body))
    return fetchApi('/agents/ag_b0f1e2d3c4a5/enable').catch((error: unknown) => error)
  }

  it('keeps the list on the error as sent, for the readiness reader to parse', async () => {
    const checks = [{ id: 'dial', status: 'fail', detail: 'human-driven', fix: 'Set AI-driven.', docs: '', required: true }]
    const error = await caught({ error: 'the agent is not ready to run', checks })
    expect(error instanceof ApiError && [error.status, error.message, error.checks])
      .toStrictEqual([409, 'the agent is not ready to run', checks])
  })

  it('keeps nothing that is not a list, or a list too long to be one', async () => {
    const odd = await caught({ error: 'refused', checks: 'dial' })
    const long = await caught({ error: 'refused', checks: Array.from({ length: 51 }, () => ({ id: 'x' })) })
    expect([odd instanceof ApiError && odd.checks, long instanceof ApiError && long.checks]).toStrictEqual([undefined, undefined])
  })
})

describe('an accepted answer', () => {
  it('reads a 202\'s body like a 200\'s (an engineering run\'s start: the run is written, its launch under way)', async () => {
    fetchMock().mockResolvedValueOnce({ ok: true, status: 202, json: () => Promise.resolve({ run: { run_id: 'RUN1' } }) })
    expect(await fetchApi<unknown>('/agents/engineering/runs', { method: 'POST', body: '{}' }))
      .toStrictEqual({ run: { run_id: 'RUN1' } })
  })
})

// The rejection of a non-OK response: the status is a typed field, and the
// server's own `message` is the error text whenever it sent one, so a caller
// (the sharing dialog, a toast) can show the reason rather than a number.
describe('error bodies', () => {
  const SERVER_MESSAGE = 'Project not found'

  /** The rejection `fetchApi` produces for `status` with this response body. */
  async function rejectionFor(status: number, body?: string): Promise<unknown> {
    mockFailureOnce(status, body)
    return fetchApi('/projects/p1').then(
      () => { throw new Error('fetchApi resolved') },
      (reason: unknown) => reason,
    )
  }

  /** `{ isApiError, status, message, typedStatus }` of a rejection, for one structured assertion. */
  function describeRejection(reason: unknown) {
    return {
      isApiError: reason instanceof ApiError,
      status: reason instanceof ApiError ? reason.status : undefined,
      message: reason instanceof Error ? reason.message : undefined,
      typedStatus: apiErrorStatus(reason),
    }
  }

  function apiError(status: number, message: string) {
    return { isApiError: true, status, message, typedStatus: status }
  }

  it('surfaces the server message as the error text and keeps the status typed', async () => {
    const reason = await rejectionFor(404, JSON.stringify({ success: false, message: SERVER_MESSAGE }))
    expect(describeRejection(reason)).toStrictEqual(apiError(404, SERVER_MESSAGE))
  })

  it('trims the message and ignores every other key of the body', async () => {
    const reason = await rejectionFor(403, JSON.stringify({ message: `  ${SERVER_MESSAGE}  `, detail: 'secret', statusCode: 403 }))
    expect(describeRejection(reason)).toStrictEqual(apiError(403, SERVER_MESSAGE))
  })

  // F1 (2026-10): every ApiError in lambda/shared/api.py answers `{success: false, error}`,
  // with no `message`. Read only `message`, the no-feedback 400 reached the persona
  // wizard as "API Error: 400" instead of its reason.
  it('surfaces the app Lambdas\' `error` key when there is no `message`', async () => {
    const reason = await rejectionFor(400, JSON.stringify({ success: false, error: 'No feedback data found for the given filters' }))
    expect(describeRejection(reason)).toStrictEqual(apiError(400, 'No feedback data found for the given filters'))
  })

  it('prefers `message` over `error`, and skips a malformed `message` for a usable `error`', async () => {
    const both = await rejectionFor(413, JSON.stringify({ error: 'from error', message: SERVER_MESSAGE }))
    expect(describeRejection(both)).toStrictEqual(apiError(413, SERVER_MESSAGE))
    const badMessage = await rejectionFor(400, JSON.stringify({ message: 42, error: 'from error' }))
    expect(describeRejection(badMessage)).toStrictEqual(apiError(400, 'from error'))
  })

  it('keeps a machine-readable `code` beside the reason (ApiError.code), and only a snake_case word', async () => {
    const coded = await rejectionFor(409, JSON.stringify({ success: false, error: 'Some were not marked', code: 'addressed_some_full' }))
    expect([describeRejection(coded), apiErrorCode(coded)]).toStrictEqual([apiError(409, 'Some were not marked'), 'addressed_some_full'])
    const odd = await Promise.all([{ code: 'Not A Code' }, { code: 7 }, {}].map((extra) =>
      rejectionFor(409, JSON.stringify({ success: false, error: 'x', ...extra }))))
    expect(odd.map(apiErrorCode)).toStrictEqual([null, null, null])
  })

  it.each([
    { status: 500, body: undefined },
    { status: 409, body: JSON.stringify({ success: false }) },
    { status: 400, body: JSON.stringify({ message: '   ' }) },
    { status: 400, body: JSON.stringify({ message: 42 }) },
  ])('falls back to the status text when the body has no message ($status, $body)', async ({ status, body }) => {
    expect(describeRejection(await rejectionFor(status, body))).toStrictEqual(apiError(status, `API Error: ${String(status)}`))
  })

  // Pins `MAX_SERVER_MESSAGE_CHARS` in client.ts (not exported: a spec would be its only reader).
  it.each([
    { status: 502, body: '<html>Bad Gateway</html>', message: 'API Error: 502' },
    { status: 400, body: JSON.stringify({ message: 'x'.repeat(301) }), message: 'API Error: 400' },
    { status: 400, body: JSON.stringify({ message: 'y'.repeat(300) }), message: 'y'.repeat(300) },
  ])('falls back when the body is not JSON or is longer than a message ($status → $message)', async ({ status, body, message }) => {
    expect(describeRejection(await rejectionFor(status, body))).toStrictEqual(apiError(status, message))
  })

  it('reports a failed 401 retry as the session-expired error, not the retry body', async () => {
    stubLocationReplace()
    mockStatusOnce(401)
    mockFailureOnce(403, JSON.stringify({ message: SERVER_MESSAGE }))
    await expect(fetchApi('/projects/p1')).rejects.toThrow('Session expired. Please login again.')
  })
})

describe('the request scope: a deployment-wide call names no workspace', () => {
  afterEach(() => setCurrentWorkspace(null))

  it('names the current workspace by default, and none when the call opts out', async () => {
    setCurrentWorkspace(ACME)
    mockJsonOnce({})
    mockJsonOnce({})
    await fetchApi('/settings/brand')
    await fetchApi('/settings/brand', { method: 'GET' }, 'deployment')
    expect(requestHeaders(0)['X-Workspace-Id']).toBe(ACME.id)
    expect(requestHeaders(1)).toStrictEqual({ 'Content-Type': 'application/json', Authorization: DEFAULT_ID_TOKEN })
  })

  it('keeps the opt-out on the 401 retry', async () => {
    setCurrentWorkspace(ACME)
    queueUnauthorizedThenOk()
    await fetchApi('/settings/brand', { method: 'PUT', body: '{}' }, 'deployment')
    expect(fetchMock()).toHaveBeenCalledTimes(2)
    expect(requestHeaders(1)['X-Workspace-Id']).toBeUndefined()
  })
})

describe('the deployment-only operator calls name no workspace, inside one too', () => {
  // The API refuses them with X-Workspace-Id (400): the schedule every workspace's tick fans out from, and the
  // S3 import's bucket, which is not keyed by workspace (docs/multi-workspace.md, 7.04.00).
  afterEach(() => setCurrentWorkspace(null))

  it.each([
    ['enable a source', () => api.enableSource('webscraper')],
    ['disable a source', () => api.disableSource('webscraper')],
    ['Run now of the S3 import', () => api.runSource('s3_import')],
    ['list the S3 import sources', () => api.getS3ImportSources()],
    ['list the S3 import files', () => api.getS3ImportFiles({ source: 'reviews' })],
    ['ask for an S3 import upload URL', () => api.getS3UploadUrl('a.csv', 'reviews')],
    ['delete an S3 import file', () => api.deleteS3ImportFile('reviews/a.csv')],
  ])('%s', async (_name, call) => {
    setCurrentWorkspace(ACME)
    mockJsonOnce({})
    await call()
    expect(requestHeaders(0)['X-Workspace-Id']).toBeUndefined()
  })

  it("keeps the workspace on any other source's Run now", async () => {
    setCurrentWorkspace(ACME)
    mockJsonOnce({})
    await api.runSource('webscraper')
    expect(requestHeaders(0)['X-Workspace-Id']).toBe(ACME.id)
  })
})

describe("the agents and workflows calls name no workspace, inside one too (7.80.00)", () => {
  // The agents API acts in the workspace a request names since 7.80.00 (docs/multi-workspace.md 3g3-a), but the web
  // app keeps the deployment's agents and workflows until the workspace Agents page ships (3g3-ui-agents): every call
  // of agentsApi and workflowsApi goes in the deployment's scope. The answer's shape does not matter here.
  afterEach(() => setCurrentWorkspace(null))

  const AGENT = 'ag_0123456789ab'
  const WORKFLOW = 'wf_0123456789ab'
  const RUN = 'ar_019a2b3c4d5e0123'
  const DEFINITION: WorkflowDefinition = workflowDefinitionSchema.parse(MINI_WORKFLOW)
  // (an answer of the wrong shape makes the call reject: only the request it sent is checked here)
  const answerShapeIgnored = (): null => null
  const calls: [string, () => Promise<unknown>][] = [
    ['agents: list', () => agentsApi.list()], ['agents: get', () => agentsApi.get(AGENT)],
    ['agents: create', () => agentsApi.create({ name: 'Scout' })], ['agents: update', () => agentsApi.update(AGENT, {})],
    ['agents: archive', () => agentsApi.archive(AGENT)], ['agents: enable', () => agentsApi.enable(AGENT)],
    ['agents: disable', () => agentsApi.disable(AGENT)], ['agents: pause', () => agentsApi.pause(AGENT)],
    ['agents: resume', () => agentsApi.resume(AGENT)], ['agents: run', () => agentsApi.run(AGENT)],
    ['agents: runs', () => agentsApi.listRuns(AGENT)], ['agents: a run', () => agentsApi.getRun(AGENT, RUN)],
    ['agents: events', () => agentsApi.listEvents(AGENT, RUN, 0)], ['agents: cancel', () => agentsApi.cancelRun(AGENT, RUN)],
    ['agents: decision', () => agentsApi.decideRun(AGENT, RUN, 'stop')],
    ['workflows: list', () => workflowsApi.list()], ['workflows: get', () => workflowsApi.get(WORKFLOW)],
    ['workflows: a revision', () => workflowsApi.getRevision(WORKFLOW, 1)],
    ['workflows: create', () => workflowsApi.create(DEFINITION)],
    ['workflows: save', () => workflowsApi.save(WORKFLOW, DEFINITION, 1)],
    ['workflows: expanded', () => workflowsApi.expanded(WORKFLOW)],
    ['workflows: duplicate', () => workflowsApi.duplicate(WORKFLOW)],
    ['workflows: rename', () => workflowsApi.rename(WORKFLOW, 'Renamed')],
    ['workflows: archive', () => workflowsApi.archive(WORKFLOW)],
    ['workflows: export', () => workflowsApi.exportDefinition(WORKFLOW)],
    ['workflows: validate', () => workflowsApi.validate({})],
  ]

  it.each(calls)('%s', async (_name, call) => {
    setCurrentWorkspace(ACME)
    mockJsonOnce({})
    await call().catch(answerShapeIgnored)
    expect(fetchMock()).toHaveBeenCalledTimes(1)
    expect(requestHeaders(0)['X-Workspace-Id']).toBeUndefined()
  })
})

describe("the Data sources calls: the workspace's by default, the deployment's on request (7.50.00)", () => {
  // Administration → Sources → Source settings → Deployment (pages/Settings/DataSourcesPage.tsx) asks for 'deployment' inside a workspace.
  afterEach(() => setCurrentWorkspace(null))

  const calls: [string, (scope?: 'deployment') => Promise<unknown>][] = [
    ['the credentials status', (scope) => api.getIntegrationStatus(scope)],
    ['a credentials save', (scope) => api.updateIntegrationCredentials('github_issues', { repos: 'o/r' }, scope)],
    ['a credentials read', (scope) => api.getIntegrationCredentials('github_issues', ['github_app_id'], scope)],
    ['the schedules and pauses', (scope) => api.getSourcesStatus(undefined, scope)],
    ['a pause reset', (scope) => api.resetSource('webscraper', scope)],
  ]

  it.each(calls)('%s names the current workspace by default', async (_name, call) => {
    setCurrentWorkspace(ACME)
    mockJsonOnce({})
    await call()
    expect(requestHeaders(0)['X-Workspace-Id']).toBe(ACME.id)
  })

  it.each(calls)("%s names no workspace in the deployment's scope", async (_name, call) => {
    setCurrentWorkspace(ACME)
    mockJsonOnce({})
    await call('deployment')
    expect(requestHeaders(0)['X-Workspace-Id']).toBeUndefined()
  })
})

describe('401 handling', () => {
  it('refreshes session and retries on 401 response', async () => {
    queueUnauthorizedThenOk()

    await api.getFeedback({ days: 7 })

    expect(authService.refreshSession).toHaveBeenCalledWith()
    expect(fetchMock()).toHaveBeenCalledTimes(2)
  })

  /**
   * The 401 retry must re-run the origin check, not just re-send the token.
   *
   * `handleUnauthorized` rebuilds headers through `buildHeaders(…, fullUrl)`
   * so a server that answers the first (unauthenticated) request with 401
   * cannot collect the refreshed token on the second. These two cases pin
   * that: the trusted one proves the retry does carry the fresh token, so
   * the untrusted one cannot pass just because the header stopped being
   * attached at all.
   *
   * Both fail if `handleUnauthorized` goes back to writing
   * `authService.getIdToken()` into a mutated headers object.
   */
  it('carries the refreshed token on the retry when the origin is trusted', async () => {
    refreshIssuesFreshToken()
    queueUnauthorizedThenOk()

    await api.getFeedback({ days: 7 })

    // Rebuilt headers re-read the token, so the retry carries the new one
    // rather than the one that just 401'd.
    expect(requestHeaders(1)['Authorization']).toBe('fresh-token')
  })

  it('does NOT attach Authorization on the retry when the origin is untrusted', async () => {
    // The deployment's real endpoint is elsewhere, so the configured base URL
    // (DEFAULT_ENDPOINT — e.g. a stale persisted value) is foreign.
    // This override is undone by the beforeEach's `mockReset()`;
    // `vi.clearAllMocks()` alone would leave it in place for every later test.
    vi.mocked(runtimeConfig.getRuntimeConfig).mockReturnValue({
      ...DEFAULT_RUNTIME_CONFIG,
      apiEndpoint: 'https://deployment.example.com/v1',
    })
    expect(DEFAULT_ENDPOINT).not.toContain('deployment.example.com')
    refreshIssuesFreshToken()
    queueUnauthorizedThenOk()

    await api.getFeedback({ days: 7 })

    // Withheld on the first request, and still withheld after the refresh,
    // which is the property the rebuilt headers exist to guarantee.
    expect({
      calls: fetchMock().mock.calls.length,
      first: requestHeaders(0)['Authorization'],
      retry: requestHeaders(1)['Authorization'],
    }).toStrictEqual({ calls: 2, first: undefined, retry: undefined })
  })

  /**
   * Regression guard for the overrides in the two tests above.
   *
   * Order-dependence is inherent, not an oversight: a leak detector has to run
   * AFTER the test that leaks, so this must stay below the untrusted-origin
   * case. Making it order-INDEPENDENT would also make it useless — with no
   * preceding override there is nothing left behind to detect.
   *
   * Two assertions on purpose. The first reads the mock state directly, so a
   * failure names the cause ("the runtime config is still the previous test's
   * foreign endpoint"). The second checks the consequence the cause produces,
   * so the guard still fires if some future leak reaches the request by another
   * route. Either fails if `beforeEach` stops re-applying the defaults.
   */
  it('starts from the default trusted allowlist, not the previous test override', async () => {
    // Cause: the mocks are back at their defaults.
    expect({
      endpoint: runtimeConfig.getRuntimeConfig().apiEndpoint,
      token: authService.getIdToken(),
    }).toStrictEqual({ endpoint: DEFAULT_ENDPOINT, token: DEFAULT_ID_TOKEN })

    mockJsonOnce(EMPTY_PAGE)

    await api.getFeedback({ days: 7 })

    // Consequence: the request goes to the trusted origin, carrying the token.
    expect(requestUrl()).toContain(DEFAULT_ENDPOINT)
    expect(requestHeaders()['Authorization']).toBe(DEFAULT_ID_TOKEN)
  })

  it('signs out and redirects with a reason when refresh fails', async () => {
    mockStatusOnce(401)
    mockStatusOnce(401)
    const replace = stubLocationReplace()

    await expect(api.getFeedback({ days: 7 })).rejects.toThrow('Session expired')
    expect(authService.signOut).toHaveBeenCalledWith()
    // The reason must travel with the redirect: without it /login cannot
    // tell the user why the app they were using stopped working.
    expect(replace).toHaveBeenCalledWith(SESSION_EXPIRED_PATH)
  })
})

describe('searchFeedback trims the query at the boundary', () => {
  // `/feedback/search` trims `q` before applying its minimum and refuses a
  // present-but-too-short term with a 400. Trimming here means the string that
  // is SENT is the string the route measures, whatever a caller passed in.
  //
  // Asserted on the REQUEST URL, not on the source text of client.ts. Matching a
  // literal like `q: params.q.trim()` would pin characters rather than behaviour,
  // and break on a reformat or an extracted local with nothing having changed.
  it('sends the trimmed term when the caller passes surrounding whitespace', async () => {
    mockJsonOnce({ count: 0, items: [], entities: {}, query: 'delivery' })

    await api.searchFeedback({ q: '  delivery  ' })

    expect(requestedParams()['q']).toBe('delivery')
  })

  it('preserves interior spaces, which are part of the term', async () => {
    mockJsonOnce({ count: 0, items: [], entities: {}, query: 'slow delivery' })

    await api.searchFeedback({ q: '  slow delivery  ' })

    // URLSearchParams decodes the encoded space; what matters is that it survives.
    expect(requestedParams()['q']).toBe('slow delivery')
  })

  it('surfaces the truncation flag the route reports', async () => {
    mockJsonOnce({ count: 1, items: [{ feedback_id: '1' }], entities: {}, query: 'x', is_partial_window: true })

    const result = await api.searchFeedback({ q: 'delivery' })

    expect(result.is_partial_window).toBe(true)
  })
})

describe('getDaysFromRange', () => {
  it.each([
    ['24h', 1], ['48h', 2], ['7d', 7], ['14d', 14], ['30d', 30], ['unknown', 14],
  ])('returns the day count for the %s range (%i)', (range, days) => {
    expect(getDaysFromRange(range)).toBe(days)
  })

  it('returns the custom lookback in days', () => {
    expect(getDaysFromRange('custom', 10)).toBe(10)
  })

  it('returns the 14-day default when custom days is null', () => {
    expect(getDaysFromRange('custom', null)).toBe(14)
  })

  it('sends 0 (all time) as-is', () => {
    expect(getDaysFromRange('custom', 0)).toBe(0)
  })

  it.each([365, 366, 9999])('sends a custom %i-day window as-is', (days) => {
    expect(getDaysFromRange('custom', days)).toBe(days)
  })

  it.each([-1, 10000, 2.5, Number.NaN])('returns the 14-day default when custom days is %s', (days) => {
    expect(getDaysFromRange('custom', days)).toBe(14)
  })
})

describe('getDateRangeParams', () => {
  it('returns days for standard ranges', () => {
    expect(getDateRangeParams('7d')).toStrictEqual({ days: 7 })
    expect(getDateRangeParams('14d')).toStrictEqual({ days: 14 })
    expect(getDateRangeParams('30d')).toStrictEqual({ days: 30 })
  })

  it('returns the custom lookback as days', () => {
    expect(getDateRangeParams('custom', 21)).toStrictEqual({ days: 21 })
  })

  it('returns the 14-day default when custom days is null', () => {
    expect(getDateRangeParams('custom', null)).toStrictEqual({ days: 14 })
  })

  it('maps the 90-day preset to WIDEST_PRESET_DAYS, within the custom range', () => {
    expect(getDateRangeParams('90d')).toStrictEqual({ days: WIDEST_PRESET_DAYS })
    expect(WIDEST_PRESET_DAYS).toBe(90)
    expect(WIDEST_PRESET_DAYS).toBeLessThanOrEqual(MAX_CUSTOM_DAYS)
  })

  it('maps the All time preset to days=0 (really all time, not the 90-day window)', () => {
    expect(getDateRangeParams('all')).toStrictEqual({ days: ALL_TIME_CUSTOM_DAYS })
    expect(ALL_TIME_CUSTOM_DAYS).toBe(0)
    expect(getDateRangeParams('all', null, 'review')).toStrictEqual({ days: 0, date_basis: 'review' })
  })

  it('only ever carries a days param (no calendar window)', () => {
    // toStrictEqual already rules out start_date / end_date keys.
    expect(getDateRangeParams('custom', 30)).toStrictEqual({ days: 30 })
  })

  it('omits date_basis for the default imported basis', () => {
    // Keeping the params shape unchanged for 'imported' preserves existing
    // request URLs and TanStack Query cache keys.
    expect(getDateRangeParams('7d', null, 'imported')).toStrictEqual({ days: 7 })
    expect(getDateRangeParams('7d')).toStrictEqual({ days: 7 })
  })

  it('includes date_basis=review when filtering by review date', () => {
    expect(getDateRangeParams('30d', null, 'review')).toStrictEqual({ days: 30, date_basis: 'review' })
  })

  it('combines the custom lookback with the review basis', () => {
    expect(getDateRangeParams('custom', 14, 'review')).toStrictEqual({ days: 14, date_basis: 'review' })
  })
})
