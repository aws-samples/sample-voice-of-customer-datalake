/**
 * Latency budgets: a p95 ceiling per screen and per API endpoint, asserted by
 * `screens.spec.ts` (navigation DOMContentLoaded and the slowest API call a screen
 * makes) and `api-sweep.spec.ts` (each direct GET).
 *
 * Mode, from `E2E_BUDGETS`:
 * - `hard` (default): a breach fails the test.
 * - `soft`: a breach is recorded as a `budget` annotation (in the HTML report and
 *   `playwright-results.json`) and the test goes on; use it to measure a new
 *   deployment before tightening or loosening a number.
 * - `off`: not checked at all.
 *
 * Every number below is derived from production measurements, and its source is
 * named next to it. Two evidence sets (both read-only runs against 2.14.00), kept
 * outside the repository in the e2e evidence folder:
 * - VERIFY = `<evidence>/verify/` (2026-10-06 05:32–07:06Z):
 *   `default/api-sweep-{admin,user}.json` (one direct GET per endpoint and role,
 *   154 samples), and the step records in `default/steps`, `final/run1/steps`,
 *   `final/run2/steps` and `design/steps` (235 navigations, 193 screens' API calls).
 * - PERF = `<evidence>/qa/perf/` (REPORT.md, table-after.md):
 *   Lambda REPORT p95 and init (cold-start) maxima over 24 h of real traffic.
 *
 * How a budget is set: the measured p95 (or, for a single-sample endpoint, its
 * worst sample) times ~1.3–2, rounded up to 500 ms, and never below the worst
 * cold start PERF saw for an API Lambda (init max 1,698–2,140 ms, table-after.md)
 * plus a warm call: a cold container must not fail a hard run. A single sample is
 * judged against the p95 budget, which is why the headroom is generous.
 */
import { expect, type TestInfo } from '@playwright/test'
import type { NetCall } from './recorder'

export type BudgetMode = 'hard' | 'soft' | 'off'

const MODES: readonly BudgetMode[] = ['hard', 'soft', 'off']

function isBudgetMode(value: unknown): value is BudgetMode {
  return typeof value === 'string' && MODES.some((mode) => mode === value)
}

/** `E2E_BUDGETS`, case-insensitive; unset or empty is `hard`. Anything else is a configuration error. */
export function budgetMode(raw: string | undefined = process.env['E2E_BUDGETS']): BudgetMode {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '') return 'hard'
  if (isBudgetMode(value)) return value
  throw new Error(`E2E_BUDGETS must be one of ${MODES.join(', ')} (got "${raw ?? ''}")`)
}

export interface Budget {
  /** p95 ceiling in ms. */
  p95Ms: number
  /** Where the number comes from (kept in code so a reviewer can re-derive it). */
  source: string
}

interface PatternBudget extends Budget {
  pattern: RegExp
}

// ---------------------------------------------------------------- screens

/**
 * Navigation DOMContentLoaded (`StepRecord.navigation.domContentLoadedMs`).
 * VERIFY: 235 navigations, p95 726 ms, every app screen ≤ 799 ms.
 */
export const SCREEN_DCL_DEFAULT: Budget = { p95Ms: 1_500, source: 'VERIFY steps: DCL p95 726 ms over 235 navigations (2×, rounded)' }

/** The first navigation of a run pays the cold CloudFront/TLS path. */
const SCREEN_DCL_OVERRIDES: readonly PatternBudget[] = [
  { pattern: /^login$/, p95Ms: 3_500, source: 'VERIFY steps: login DCL max 2,511 ms (n=8), the first page of each run' },
]

/**
 * The slowest API call (excluding the `/chat/stream` SSE, which is long by design)
 * a screen makes while it loads. VERIFY: 193 step records, p95 2,819 ms; the worst
 * READ screen is admin-logs at 3,440 ms (`/logs/summary`, before PERF's parallel
 * fix 4e11b7a0).
 */
export const SCREEN_SLOWEST_CALL_DEFAULT: Budget = {
  p95Ms: 4_500,
  source: 'VERIFY steps: slowest call per screen p95 2,819 ms, worst read screen admin-logs 3,440 ms (1.3×, rounded)',
}

const SCREEN_SLOWEST_CALL_OVERRIDES: readonly PatternBudget[] = []

// ---------------------------------------------------------------- endpoints

/**
 * Every endpoint without an override. VERIFY sweep: 79 paths × 2 roles, most
 * 175–760 ms (≈180 ms warm, ≈460 ms with a cold container); PERF: API Lambda
 * init max 2,140 ms (voc-chat-api).
 */
export const ENDPOINT_DEFAULT: Budget = {
  p95Ms: 3_000,
  source: 'VERIFY sweep: typical 175–760 ms; PERF table-after.md: API init max 2,140 ms + a warm call',
}

/**
 * Endpoints that measured slow for a known reason. Matched against the sweep's
 * path with its query string (first match wins), so anchor on the route.
 */
const ENDPOINT_OVERRIDES: readonly PatternBudget[] = [
  { pattern: /^\/sources\/status\b/, p95Ms: 4_000, source: 'VERIFY sweep 2,926 / 1,036 ms; PERF REPORT step 2: 5× parallel 4.0 s before a78b2620' },
  { pattern: /^\/logs\/validation\b/, p95Ms: 4_000, source: 'VERIFY sweep 2,674 / 914 ms; browser p95 3,212 ms (per-source reads, PERF F4)' },
  { pattern: /^\/logs\/summary\b/, p95Ms: 4_500, source: 'VERIFY browser p95 3,440 ms; sweep 833 / 778 ms' },
  { pattern: /^\/users(\?|$)/, p95Ms: 3_500, source: 'VERIFY sweep 2,505 / 481 ms, browser p95 3,150 ms; PERF REPORT: p95 1,381 ms after the fix' },
  { pattern: /^\/memory(\?|$)/, p95Ms: 3_500, source: 'VERIFY sweep 2,280 / 635 ms, browser p95 3,171 ms' },
  { pattern: /^\/s3-import\/sources\b/, p95Ms: 3_500, source: 'VERIFY sweep 2,231 / 2,281 ms (lists the import bucket every call)' },
  { pattern: /^\/scrapers\/manual\/parse\//, p95Ms: 3_500, source: 'VERIFY sweep 2,258 / 1,966 ms (fake id: the 404 path still reads S3)' },
  { pattern: /^\/projects\/[^/?]+(\?|$)/, p95Ms: 4_500, source: 'VERIFY sweep 1,445 / 1,713 ms; browser p95 up to 3,919 ms for the largest legacy project' },
]

function firstMatch(overrides: readonly PatternBudget[], key: string, fallback: Budget): Budget {
  const hit = overrides.find((entry) => entry.pattern.test(key))
  return hit === undefined ? fallback : { p95Ms: hit.p95Ms, source: hit.source }
}

export function screenDclBudget(step: string): Budget {
  return firstMatch(SCREEN_DCL_OVERRIDES, step, SCREEN_DCL_DEFAULT)
}

export function screenSlowestCallBudget(step: string): Budget {
  return firstMatch(SCREEN_SLOWEST_CALL_OVERRIDES, step, SCREEN_SLOWEST_CALL_DEFAULT)
}

/** The budget for an API path (without the stage prefix, with its query string). */
export function endpointBudget(apiPath: string): Budget {
  return firstMatch(ENDPOINT_OVERRIDES, apiPath, ENDPOINT_DEFAULT)
}

/** Long-lived by design (SSE), so never judged as "the slowest call". */
const STREAMING_PATH = /\/chat\/stream$/

/** The slowest finished call to the API host, as `METHOD /path` and ms; null when there is none. */
export function slowestApiCall(
  calls: ReadonlyArray<Pick<NetCall, 'method' | 'path' | 'host' | 'durationMs'>>, apiHost: string,
): { label: string; ms: number } | null {
  let slowest: { label: string; ms: number } | null = null
  for (const call of calls) {
    if (call.host !== apiHost || call.durationMs === null || STREAMING_PATH.test(call.path)) continue
    if (slowest === null || call.durationMs > slowest.ms) slowest = { label: `${call.method} ${call.path}`, ms: call.durationMs }
  }
  return slowest
}

// ---------------------------------------------------------------- judging

export interface Breach {
  /** What was measured, e.g. `screen dashboard DCL` or `GET /feedback?days=30`. */
  subject: string
  measuredMs: number
  budget: Budget
}

/** A breach when `measuredMs` is over the budget; null (no data) is never a breach. */
export function breachOf(subject: string, measuredMs: number | null, budget: Budget): Breach | null {
  if (measuredMs === null || !Number.isFinite(measuredMs) || measuredMs <= budget.p95Ms) return null
  return { subject, measuredMs, budget }
}

export function describeBreach(breach: Breach): string {
  return `${breach.subject}: ${breach.measuredMs} ms > p95 budget ${breach.budget.p95Ms} ms (${breach.budget.source})`
}

/**
 * Applies the mode: `hard` fails (one assertion listing every breach), `soft`
 * annotates each breach, `off` does nothing. Call it after the evidence is written.
 */
export function enforceBudgets(testInfo: TestInfo, breaches: ReadonlyArray<Breach | null>, mode: BudgetMode = budgetMode()): void {
  const real = breaches.filter((breach): breach is Breach => breach !== null)
  if (mode === 'off' || real.length === 0) return
  const lines = real.map(describeBreach)
  if (mode === 'soft') {
    for (const line of lines) testInfo.annotations.push({ type: 'budget', description: line })
    return
  }
  expect(lines, 'latency budgets (E2E_BUDGETS=soft records these instead of failing)').toEqual([])
}
