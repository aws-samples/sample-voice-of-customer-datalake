/**
 * API-level security probes (E2E-COVERAGE-GAPS §2: #379, #244, #263, 2.12 CORS /
 * error-body / logs fixes). No browser, and no write that outlives the spec: the
 * one form it may create is e2e-named, in the ledger, and deleted in afterAll.
 *
 * Contracts, from the handlers:
 * - `GET /feedback-forms/{id}/iframe` (public, feedback_form_handler.py): an id
 *   that is not ours or does not exist is a JSON 404 that reflects nothing; a real
 *   form's page carries `_IFRAME_SECURITY_HEADERS` (CSP `default-src 'none'`,
 *   `nosniff`, `no-referrer`).
 * - A gateway 401 (api-gateway.ts `Unauthorized` response) names the deployment's
 *   frontend origin (never `*` outside dev), varies on Origin and Authorization,
 *   and challenges with `Bearer`.
 * - `POST /scrapers/analyze-url` and `POST /scrapers` are admin-only (owner
 *   decision 2026-10-08): e2e-user gets 403 before any validation, fetch or model
 *   call. For the admin, analyze-url refuses internal targets with a 400
 *   (`shared/url_policy.validate_url`), before any fetch or model call; a public
 *   URL that REDIRECTS to one is refused hop by hop (`_ValidatingRedirectHandler`).
 * - `days` (shared/api.py `validate_days`) never raises: junk falls back to the
 *   route's default window (`/logs/summary` answers `days: 7`), never a 5xx.
 * - Error bodies are `{success:false, error}` (`_register_exception_handlers`):
 *   short, with no exception class, traceback or file path.
 * - `DELETE /logs/validation/{source}` is admin-only (`require_admin`): e2e-user
 *   gets 403. The admin is NEVER sent that DELETE (it would erase logs).
 */
import { expect, request as playwrightRequest, type APIRequestContext, type APIResponse } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { RUN_PREFIX, apiUrl, siteUrl, type Role } from '../lib/env'
import { roleOf } from '../lib/fixtures'
import { readLedger, recordCreated } from '../lib/ledger'
import { idTokenFor } from '../lib/session'
import { isRecord } from '../lib/guards'
import { e2eFetch, nodeUserAgent } from '../lib/trafficTag'

const FORM_NAME = `${RUN_PREFIX}security-probe-form`

/** Not one of our form ids (`_FORM_ID_PATTERN`) and an HTML/script payload: must be refused, never reflected. */
// No `/`: an encoded slash in a path parameter is routed (or refused) by API Gateway itself,
// which would test the gateway, not the handler's id gate.
const HOSTILE_FORM_ID = encodeURIComponent('e2e"><img src=x onerror=alert(1)>')
/** Shaped like an id, but no such form. */
const MISSING_FORM_ID = 'e2e-nonexistent-0000'

/** Internal targets `validate_url` must refuse (400) with no fetch. */
const SSRF_TARGETS: ReadonlyArray<{ url: string; why: string }> = [
  { url: 'http://169.254.169.254/latest/meta-data/', why: 'EC2/Lambda metadata IP' },
  { url: 'http://[::ffff:169.254.169.254]/latest/meta-data/', why: 'metadata IP as IPv4-mapped IPv6' },
  { url: 'http://localhost:9001/2018-06-01/runtime/invocation/next', why: 'localhost (Lambda Runtime API)' },
  { url: 'http://127.0.0.1/', why: 'loopback' },
  { url: 'file:///etc/passwd', why: 'non-http scheme' },
]

const METADATA_URL = encodeURIComponent('http://169.254.169.254/latest/meta-data/')

/**
 * Public redirectors to the metadata IP, tried in order; the first that answers a real redirect is probed.
 * E2E_SSRF_REDIRECT_URL (one you control) goes first. httpbin.org answers 403 "Forbidden redirect target"
 * for internal targets since 2026-10; httpbin.dev still redirects. The test skips only when none does.
 */
const SSRF_REDIRECT_CANDIDATES: readonly string[] = [
  ...(process.env['E2E_SSRF_REDIRECT_URL'] ? [process.env['E2E_SSRF_REDIRECT_URL']] : []),
  `https://httpbin.dev/redirect-to?url=${METADATA_URL}`,
  `https://httpbin.org/redirect-to?url=${METADATA_URL}`,
]

/** Whether `url` answers a 3xx with a Location (fetched without following it). */
async function redirectorAnswersRedirect(url: string): Promise<{ redirects: boolean; detail: string }> {
  try {
    const res = await e2eFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const location = res.headers.get('location')
    const redirects = res.status >= 300 && res.status < 400 && location !== null
    return { redirects, detail: redirects ? `${res.status} -> ${location}` : `HTTP ${res.status}` }
  } catch (error: unknown) {
    return { redirects: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** The first candidate that redirects, or why none did. */
async function workingRedirector(): Promise<{ url: string | null; tried: string[] }> {
  const tried: string[] = []
  for (const url of SSRF_REDIRECT_CANDIDATES) {
    const check = await redirectorAnswersRedirect(url)
    if (check.redirects) return { url, tried }
    tried.push(`${new URL(url).host}: ${check.detail}`)
  }
  return { url: null, tried }
}

/** Bodies `analyze-url` must refuse as a client error (label, probe options). */
const MALFORMED_BODIES: ReadonlyArray<readonly [string, { rawBody?: string; body?: unknown }]> = [
  ['bad JSON body', { rawBody: '{"url":' }],
  ['body not an object', { body: ['http://example.com'] }],
]

/** Probes whose status has its own test; the error-body test still checks their bodies for leaks. */
const STATUS_JUDGED_ELSEWHERE: ReadonlySet<string> = new Set(['analyze-url redirect', ...MALFORMED_BODIES.map(([label]) => label)])

/** What an error body must never contain: exception classes, tracebacks, SDK names, file paths. */
const LEAK = /Traceback|botocore|boto3|File "\/|\/var\/task|\/opt\/python|\b[A-Z][A-Za-z]+(Error|Exception):|\.py\b/
/** An `{success:false, error}` body is one short sentence. */
const MAX_ERROR_BODY_CHARS = 300

/** The error answers the error-body test collects (every `probe` call appends; that test resets it first). */
const errorBodies: Array<{ probe: string; status: number; body: string }> = []

interface Probe {
  status: number
  headers: Record<string, string>
  text: string
}

async function probe(
  api: APIRequestContext, label: string, method: 'GET' | 'POST' | 'DELETE', path: string,
  options: { role?: Role; body?: unknown; rawBody?: string; authorization?: string; origin?: string } = {},
): Promise<Probe> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.role !== undefined) headers['Authorization'] = idTokenFor(options.role)
  if (options.authorization !== undefined) headers['Authorization'] = options.authorization
  if (options.origin !== undefined) headers['Origin'] = options.origin
  const data = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
  const response: APIResponse = await api.fetch(`${apiUrl()}${path}`, { method, headers, data, maxRedirects: 0 })
  const text = await response.text()
  if (response.status() >= 400) errorBodies.push({ probe: label, status: response.status(), body: text.slice(0, 1_000) })
  return { status: response.status(), headers: response.headers(), text }
}

const errorText = (p: Probe): string => {
  try {
    const body: unknown = JSON.parse(p.text)
    return isRecord(body) ? String(body['error'] ?? body['message'] ?? '') : ''
  } catch {
    return ''
  }
}

/** A real form id for the iframe header probe: an existing one (read-only) or a new e2e form (ledger + afterAll delete). */
async function someFormId(): Promise<{ id: string; created: boolean }> {
  const existing = stringField(listOf((await apiCall('admin', 'GET', '/feedback-forms')).body, 'forms')[0], 'form_id', 'id')
  if (existing !== undefined) return { id: existing, created: false }
  const res = await apiCall('admin', 'POST', '/feedback-forms', { name: FORM_NAME })
  const form = isRecord(res.body) && isRecord(res.body['form']) ? res.body['form'] : undefined
  const id = stringField(form, 'form_id', 'id')
  expect(res.status, 'POST /feedback-forms (e2e form for the header probe)').toBeLessThan(300)
  if (id === undefined) throw new Error('created form has no id')
  recordCreated('feedback-form', id, FORM_NAME)
  return { id, created: true }
}

/** How long an analyze-url assist job may take to settle (one fetch, at most a model call). */
const ASSIST_JOB_TIMEOUT_MS = 120_000

function jsonBody(res: Probe): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(res.text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Polls `GET /scrapers/jobs/{id}` (its starter: the admin) until the job is completed or failed. */
async function finishedAssistJob(jobId: string): Promise<{ status: string; error: string; text: string }> {
  const deadline = Date.now() + ASSIST_JOB_TIMEOUT_MS
  for (;;) {
    const poll = await apiCall('admin', 'GET', `/scrapers/jobs/${encodeURIComponent(jobId)}`)
    expect(poll.status, 'GET /scrapers/jobs/{id}').toBe(200)
    // The poll answer IS the job view (assist_jobs.view: job_id, status, error, result…).
    const job = isRecord(poll.body) ? poll.body : undefined
    const status = stringField(job, 'status') ?? ''
    if (status === 'completed' || status === 'failed' || Date.now() > deadline) {
      return { status, error: stringField(job, 'error') ?? '', text: JSON.stringify(poll.body) }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

test.describe('security probes (API level)', () => {
  let api: APIRequestContext

  test.beforeAll(async () => {
    // A bare context: no saved session, no cookies; each probe sets its own headers.
    api = await playwrightRequest.newContext({ userAgent: nodeUserAgent() })
  })

  test.afterAll(async () => {
    for (const entry of readLedger().filter((e) => e.kind === 'feedback-form' && e.name === FORM_NAME)) {
      await apiCall('admin', 'DELETE', `/feedback-forms/${encodeURIComponent(entry.id)}`)
    }
    await api.dispose()
  })

  test('feedback-form iframe: a bad or missing id is a JSON 404 that reflects nothing (#379)', async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'public route: probed once')
    const badIds: ReadonlyArray<readonly [string, string]> = [['hostile id', HOSTILE_FORM_ID], ['missing id', MISSING_FORM_ID]]
    for (const [label, id] of badIds) {
      const res = await probe(api, `iframe ${label}`, 'GET', `/feedback-forms/${id}/iframe`)
      expect(res.status, label).toBe(404)
      expect(res.headers['content-type'] ?? '', `${label}: no HTML page for an id that is not a form`).not.toContain('text/html')
      expect(res.text, `${label}: nothing reflected`).not.toMatch(/<img|onerror|alert\(1\)/i)
    }
  })

  test('feedback-form iframe: a real form is served with CSP, nosniff and no-referrer (#379)', async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'public route: probed once')
    const { id, created } = await someFormId()
    testInfo.annotations.push({ type: 'form', description: created ? 'e2e form created (deleted in afterAll)' : 'existing form (read-only)' })
    const res = await probe(api, 'iframe real form', 'GET', `/feedback-forms/${encodeURIComponent(id)}/iframe`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type'] ?? '').toContain('text/html')
    const csp = res.headers['content-security-policy'] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
    // The page exists to be framed on customers' sites: no frame-ancestors.
    expect(csp).not.toContain('frame-ancestors')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
  })

  test("a gateway 401 carries the site's CORS origin, Vary and a Bearer challenge", async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'unauthenticated: probed once')
    const origin = new URL(siteUrl()).origin
    const res = await probe(api, '401 no token', 'GET', '/projects', { origin })
    expect(res.status).toBe(401)
    const allowed = res.headers['access-control-allow-origin']
    // `*` only in dev (api-stack.ts allowedOrigin); a deployed site names itself.
    expect(allowed, 'the browser can read the 401 (no opaque CORS failure)').toBe(origin)
    expect(res.headers['vary'] ?? '').toMatch(/\bOrigin\b/)
    expect(res.headers['vary'] ?? '').toMatch(/\bAuthorization\b/)
    expect(res.headers['www-authenticate'] ?? '').toMatch(/^Bearer\b/)
    expect(res.headers['access-control-allow-credentials'], 'no credentialed CORS').toBeUndefined()
  })

  test('scraper analyze-url refuses internal targets: 400 for the admin, 403 for e2e-user (#244)', async ({}, testInfo) => {
    const role = roleOf(testInfo)
    for (const target of SSRF_TARGETS) {
      const res = await probe(api, `analyze-url ${target.why}`, 'POST', '/scrapers/analyze-url', { role, body: { url: target.url } })
      expect.soft(res.status, `${target.why}: ${target.url}`).toBe(role === 'admin' ? 400 : 403)
      expect.soft(errorText(res), `${target.why}: refused`).toMatch(role === 'admin' ? /not allowed|only http and https/i : /admin access required/i)
    }
  })

  test('e2e-user cannot save a scraper (403, admin-only since 2026-10-08)', async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'user', 'the admin is never sent a save from this spec')
    // An id the save validation refuses: if the gate regressed, the answer is a 400
    // and nothing is written, rather than a scraper left in the shared secret.
    const body = { scraper: { id: 'e2e invalid id!', base_url: 'https://example.com/' } }
    const res = await probe(api, 'user save scraper', 'POST', '/scrapers', { role: 'user', body })
    expect(res.status).toBe(403)
  })

  test('scraper analyze-url refuses a public URL that redirects to the metadata IP (#244)', async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'one outbound fetch per run')
    test.setTimeout(ASSIST_JOB_TIMEOUT_MS + 30_000)
    // The probe proves something only while its public redirector really answers a redirect, so the
    // first candidate that does is used (SSRF_REDIRECT_CANDIDATES); with none it skips and says why.
    const { url: redirectUrl, tried } = await workingRedirector()
    test.skip(redirectUrl === null, `no redirector answers a redirect (${tried.join('; ')}); set E2E_SSRF_REDIRECT_URL`)
    if (redirectUrl === null) return
    const res = await probe(api, 'analyze-url redirect', 'POST', '/scrapers/analyze-url', { role: 'admin', body: { url: redirectUrl } })
    // An assist job (4.00.00): the first hop is public, so the start is a 202 and the
    // worker's fetch refuses the redirect; the job ends `failed` with that refusal.
    expect(res.status, 'analyze-url starts an assist job').toBe(202)
    const jobId = stringField(jsonBody(res), 'job_id') ?? ''
    expect(jobId, 'the 202 names its job').not.toBe('')
    const job = await finishedAssistJob(jobId)
    testInfo.annotations.push({ type: 'redirect', description: `${redirectUrl} -> job ${job.status}: ${job.error}` })
    expect(job.status, 'never analysed: the redirect hop is refused').toBe('failed')
    expect(job.error).toMatch(/^Redirect refused/)
    expect(`${job.error} ${job.text}`).not.toMatch(/ami-id|instance-id|security-credentials|selectors/)
  })

  test('scraper analyze-url answers a malformed body with a 4xx, not a gateway 502', async ({}, testInfo) => {
    // `analyze_url` once called `json_body.get('url')` with no guard: invalid JSON or
    // a non-object body raised out of the handler, and API Gateway answered 502.
    // e2e-user is refused (403) before the body is read.
    const role = roleOf(testInfo)
    for (const [label, options] of MALFORMED_BODIES) {
      const res = await probe(api, label, 'POST', '/scrapers/analyze-url', { role, ...options })
      expect.soft(res.status, label).toBe(role === 'admin' ? 400 : 403)
    }
  })

  test('a junk `days` falls back to the default window, never a 5xx (#263)', async ({}, testInfo) => {
    const role = roleOf(testInfo)
    const logs = await apiCall(role, 'GET', '/logs/summary?days=abc')
    expect(logs.status).toBe(200)
    expect(isRecord(logs.body) ? logs.body['days'] : undefined, 'logs_handler DEFAULT_DAYS').toBe(7)
    for (const path of ['/metrics/summary?days=abc', '/feedback?days=abc&limit=1', '/metrics/summary?days=-5', '/metrics/summary?days=99999999']) {
      const res = await apiCall(role, 'GET', path)
      expect.soft(res.status, path).toBe(200)
    }
  })

  test('e2e-user cannot clear validation logs (403); the admin is never sent the DELETE', async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'user', 'a DELETE as admin would erase logs')
    const res = await probe(api, 'user DELETE logs', 'DELETE', '/logs/validation/e2e-none', { role: 'user' })
    expect(res.status).toBe(403)
  })

  test('error bodies are short and carry no exception text, traceback or path', async ({}, testInfo) => {
    const role = roleOf(testInfo)
    // Self-contained: Playwright restarts the worker after a failed test, which
    // resets module state, so this test makes one error answer of each kind itself.
    errorBodies.length = 0
    await probe(api, 'unknown project', 'GET', '/projects/e2e-nonexistent-0000', { role })
    await probe(api, 'bad token', 'GET', '/feedback', { authorization: 'e2e-not-a-token', origin: new URL(siteUrl()).origin })
    await probe(api, 'iframe hostile id', 'GET', `/feedback-forms/${HOSTILE_FORM_ID}/iframe`)
    await probe(api, 'analyze-url metadata IP', 'POST', '/scrapers/analyze-url', { role, body: { url: 'http://169.254.169.254/' } })
    for (const [label, options] of MALFORMED_BODIES) await probe(api, label, 'POST', '/scrapers/analyze-url', { role, ...options })
    if (role === 'user') await probe(api, 'user DELETE logs', 'DELETE', '/logs/validation/e2e-none', { role })
    expect(errorBodies.length).toBeGreaterThanOrEqual(5)
    const leaks = errorBodies.filter((e) => LEAK.test(e.body) || e.body.length > MAX_ERROR_BODY_CHARS)
    expect(leaks, 'error bodies with exception text or oversized').toEqual([])
    const fiveHundreds = errorBodies.filter((e) => e.status >= 500 && !STATUS_JUDGED_ELSEWHERE.has(e.probe))
    testInfo.annotations.push({ type: 'errors', description: errorBodies.map((e) => `${e.probe} ${e.status}`).join('; ') })
    expect(fiveHundreds, 'no probe is answered with a 5xx').toEqual([])
  })
})
