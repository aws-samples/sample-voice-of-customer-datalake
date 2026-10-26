/**
 * Shared step runner: opens a page in the requested theme, records evidence,
 * and fails the step on page errors, API 5xx, or the route error boundary.
 */
import { expect, type Locator, type Page, type Request, type Response, type TestInfo } from '@playwright/test'
import { isRecord } from './guards'
import { apiUrl, siteUrl, type Role } from './env'
import { StepRecorder, type StepRecord } from './recorder'

export function roleOf(testInfo: TestInfo): Role {
  return testInfo.project.metadata['role'] === 'admin' ? 'admin' : 'user'
}

/** `text` as a literal inside a RegExp (an e2e name or id in a locator pattern). */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type Theme = 'dark' | 'light'

/** Pins the theme before the SPA boots (themeStore persists `voc-theme`). */
export async function pinTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((pref: string) => {
    window.localStorage.setItem('voc-theme', JSON.stringify({ state: { preference: pref }, version: 0 }))
  }, theme)
}

/** A `configStore` time range the suite pins (store/configStore.ts `TimeRange`). */
export type PinnedRange = 'all' | '24h' | '48h' | '7d' | '30d' | '90d'

/**
 * Pins the time range before the SPA boots (configStore `voc-config`, persist
 * version 2, partial state): the saved session already carries a `voc-config`;
 * only the range changes.
 */
export async function pinTimeRange(page: Page, range: PinnedRange): Promise<void> {
  await page.addInitScript((timeRange: string) => {
    const raw = window.localStorage.getItem('voc-config')
    let blob: { state?: Record<string, unknown>; version?: number } = {}
    try { blob = raw === null ? {} : JSON.parse(raw) } catch { blob = {} }
    window.localStorage.setItem('voc-config', JSON.stringify({ ...blob, state: { ...(blob.state ?? {}), timeRange }, version: 2 }))
  }, range)
}

/** Pins All time, so time-scoped screens render their charts instead of the empty-range notice. */
export async function pinAllTime(page: Page): Promise<void> {
  await pinTimeRange(page, 'all')
}

export async function settle(page: Page, extraMs = 1500): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(extraMs)
}

export const ERROR_BOUNDARY_TEXT = 'Something went wrong'

/** The routed page's container inside the app shell (Layout.tsx: `<main>` → header + this); empty = a blank page. */
export const routedContent = (page: Page): Locator => page.locator('main > div.overflow-auto')

/** API hosts whose 5xx fail a step; third-party noise is recorded but not judged. */
function isAppApi(host: string): boolean {
  return host === new URL(apiUrl()).host
}

export function judge(record: Pick<StepRecord, 'calls' | 'pageErrors'>, boundaryShown: boolean): string[] {
  const problems: string[] = []
  for (const call of record.calls) {
    if (isAppApi(call.host) && call.status !== null && call.status >= 500) {
      problems.push(`${call.method} ${call.path} -> ${call.status}`)
    }
    if (isAppApi(call.host) && call.status === null && call.failure !== null && !call.failure.includes('ERR_ABORTED')) {
      problems.push(`${call.method} ${call.path} failed: ${call.failure}`)
    }
  }
  for (const error of record.pageErrors) problems.push(`pageerror: ${error}`)
  if (boundaryShown) problems.push('route error boundary rendered')
  return problems
}

export interface StepOptions {
  page: Page
  role: Role
  theme: Theme
  step: string
  audit?: boolean
  action: (recorder: StepRecorder) => Promise<void>
}

/**
 * Runs `action`, then writes the record. Returns the problems so the caller
 * can assert (a failing assertion still leaves the evidence on disk).
 */
export async function runStep(options: StepOptions): Promise<{ record: StepRecord; problems: string[] }> {
  const { page, role, theme, step, action } = options
  const recorder = new StepRecorder(page, role, theme, step)
  const errors: string[] = []
  try {
    await action(recorder)
  } catch (error) {
    errors.push(String(error).split('\n')[0]?.slice(0, 400) ?? 'error')
  }
  const boundaryShown = await page.getByText(ERROR_BOUNDARY_TEXT, { exact: true }).isVisible().catch(() => false)
  const built = await recorder.build({ audit: options.audit ?? true })
  const problems = [...errors, ...judge(built, boundaryShown)]
  const record: StepRecord = { ...built, ok: problems.length === 0, error: problems.length > 0 ? problems.join(' | ') : null }
  recorder.write(record)
  return { record, problems }
}

/** `runStep` in dark theme, failing the test on any problem (the evidence is on disk first). */
export async function assertStep(page: Page, role: Role, step: string, action: (recorder: StepRecorder) => Promise<void>): Promise<void> {
  const { record, problems } = await runStep({ page, role, theme: 'dark', step, action })
  expect(problems, `${step}: ${record.screenshot ?? ''}`).toEqual([])
}

export function site(pathname: string): string {
  return `${siteUrl()}${pathname}`
}

/** A response (or request) to the app's own API with this method and a path matching `pathPattern`. */
export function isApi(message: Response | Request, method: string, pathPattern: RegExp): boolean {
  const request = 'request' in message ? message.request() : message
  const url = new URL(request.url())
  return request.method() === method && url.origin === new URL(apiUrl()).origin && pathPattern.test(url.pathname)
}

/** The response's JSON object body ({} for anything else). */
export async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null)
  return isRecord(body) ? body : {}
}
