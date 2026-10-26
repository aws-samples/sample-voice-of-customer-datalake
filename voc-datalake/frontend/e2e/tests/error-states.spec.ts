/**
 * Error states (E2E-COVERAGE-GAPS.md I-5, E2E F3/F4): each screen's primary
 * load fails — an injected 500, 403 or timeout through `lib/inject.ts`, so
 * nothing reaches the deployment — and the screen must say so: its own error
 * state, never its "nothing here" empty state, never a blank page, never the
 * route error boundary. READ-only (every failed call is answered by the
 * browser), so it is safe on production; both roles (Admin settings only as the
 * admin).
 *
 * - Dashboard, Categories, Projects, Scrapers, Prioritization: the shared
 *   `components/LoadFailed` alert ("This could not be loaded…" + Try again)
 *   instead of "No feedback in this time range" / "No categories" / "No projects
 *   yet" / "No scrapers configured" / "No Documents Found" (all of which these
 *   pages used to claim when the read failed).
 * - Admin › General: a `role=alert` naming the failure, with Retry.
 * - Memory: "Could not load memories." (list) instead of the empty state.
 *
 * Local dev mock: E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 \
 *   npx playwright test -c playwright.config.ts --project=admin --no-deps tests/error-states.spec.ts
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { ERROR_BOUNDARY_TEXT, roleOf, routedContent, runStep, settle, site } from '../lib/fixtures'
import { injectFailure, withoutInjected, type Failure, type InjectionSpec } from '../lib/inject'
import type { Role } from '../lib/env'

const FAIL_500: Failure = { status: 500 }
const FAIL_403: Failure = { status: 403, body: { success: false, message: 'Forbidden' } }
const TIMEOUT: Failure = { timeout: true }

/** dashboard.json emptyState body: the welcome screen of a workspace with no feedback at all. */
const WORKSPACE_EMPTY = 'Your workspace is empty'
/** common.json loadFailed.message — components/LoadFailed. */
const LOAD_FAILED = 'This could not be loaded. Check your connection and try again.'
/** TanStack retries a failed read once (App.tsx `retry: 1`), and a timeout waits first. */
const ALERT_TIMEOUT_MS = 20_000

const loadFailed = (page: Page): Locator => page.getByRole('alert').filter({ hasText: LOAD_FAILED })

/** The LoadFailed alert with its Try again, and none of the page's empty-state copy. */
async function expectLoadFailedNotEmpty(page: Page, emptyCopy: readonly string[]): Promise<void> {
  await expect(loadFailed(page).first()).toBeVisible({ timeout: ALERT_TIMEOUT_MS })
  await expect(loadFailed(page).first().getByRole('button', { name: 'Try again' })).toBeVisible()
  for (const copy of emptyCopy) await expect(page.getByText(copy, { exact: true }), `not "${copy}"`).toHaveCount(0)
}

interface ErrorCase {
  step: string
  path: string
  adminOnly?: boolean
  injections: readonly InjectionSpec[]
  /** The screen's own answer to the failure. */
  expectShown: (page: Page) => Promise<void>
}

const DASHBOARD_EMPTY: readonly string[] = ['No feedback in this time range', WORKSPACE_EMPTY]
const PROJECTS_EMPTY: readonly string[] = ['No projects yet']

const CASES: readonly ErrorCase[] = [
  {
    step: 'error-dashboard-summary-500',
    path: '/dashboard',
    injections: [{ method: 'GET', path: /\/metrics\/summary$/, failure: FAIL_500 }],
    expectShown: (page) => expectLoadFailedNotEmpty(page, DASHBOARD_EMPTY),
  },
  {
    step: 'error-dashboard-summary-403',
    path: '/dashboard',
    injections: [{ method: 'GET', path: /\/metrics\/summary$/, failure: FAIL_403 }],
    expectShown: (page) => expectLoadFailedNotEmpty(page, DASHBOARD_EMPTY),
  },
  {
    step: 'error-dashboard-summary-timeout',
    path: '/dashboard',
    injections: [{ method: 'GET', path: /\/metrics\/summary$/, failure: TIMEOUT }],
    expectShown: (page) => expectLoadFailedNotEmpty(page, DASHBOARD_EMPTY),
  },
  {
    step: 'error-categories-500',
    path: '/categories',
    injections: [
      { method: 'GET', path: /\/metrics\/categories$/, failure: FAIL_500 },
      { method: 'GET', path: /\/feedback\/entities$/, failure: FAIL_500 },
      { method: 'GET', path: /\/feedback$/, failure: FAIL_500 },
    ],
    expectShown: async (page) => {
      await expectLoadFailedNotEmpty(page, ['No categories', 'No feedback found matching your filters'])
      // One alert for the analytics cards, one for the feedback list.
      await expect(loadFailed(page)).toHaveCount(2)
    },
  },
  {
    step: 'error-projects-500',
    path: '/projects',
    injections: [{ method: 'GET', path: /\/projects$/, failure: FAIL_500 }],
    expectShown: (page) => expectLoadFailedNotEmpty(page, PROJECTS_EMPTY),
  },
  {
    step: 'error-projects-403',
    path: '/projects',
    injections: [{ method: 'GET', path: /\/projects$/, failure: FAIL_403 }],
    expectShown: (page) => expectLoadFailedNotEmpty(page, PROJECTS_EMPTY),
  },
  {
    step: 'error-scrapers-500',
    path: '/scrapers',
    injections: [{ method: 'GET', path: /\/scrapers$/, failure: FAIL_500 }],
    expectShown: (page) => expectLoadFailedNotEmpty(page, ['No scrapers configured']),
  },
  {
    step: 'error-prioritization-500',
    path: '/prioritization',
    injections: [{ method: 'GET', path: /\/projects$/, failure: FAIL_500 }],
    expectShown: (page) => expectLoadFailedNotEmpty(page, ['No Documents Found', 'No Scorable Documents']),
  },
  {
    step: 'error-admin-brand-500',
    path: '/admin?tab=brand',
    adminOnly: true,
    injections: [{ method: 'GET', path: /\/settings\/brand$/, failure: FAIL_500 }],
    expectShown: async (page) => {
      const alert = page.getByRole('alert').filter({ hasText: 'load brand settings from the server' })
      await expect(alert).toBeVisible()
      await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible()
    },
  },
  {
    step: 'error-memory-list-500',
    path: '/memory',
    injections: [{ method: 'GET', path: /\/memory$/, failure: FAIL_500 }],
    expectShown: async (page) => {
      await expect(page.getByRole('alert').filter({ hasText: 'Could not load memories.' })).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText('Nothing remembered here yet.')).toHaveCount(0)
    },
  },
  {
    step: 'error-memory-list-timeout',
    path: '/memory',
    injections: [{ method: 'GET', path: /\/memory$/, failure: TIMEOUT }],
    expectShown: async (page) => {
      await expect(page.getByRole('alert').filter({ hasText: 'Could not load memories.' })).toBeVisible({ timeout: 20_000 })
    },
  },
]

async function runCase(page: Page, role: Role, c: ErrorCase): Promise<{ problems: string[]; screenshot: string | null; hits: number }> {
  const injected = await Promise.all(c.injections.map((spec) => injectFailure(page, spec)))
  const { record, problems } = await runStep({
    page, role, theme: 'dark', step: c.step,
    action: async (r) => {
      await page.goto(site(c.path), { waitUntil: 'domcontentloaded' })
      await settle(page, 1_500)
      await c.expectShown(page)
      await expect(routedContent(page), 'the page is not blank').not.toBeEmpty()
      await expect(page.getByText(ERROR_BOUNDARY_TEXT, { exact: true })).toHaveCount(0)
      r.note(`injected: ${c.injections.map((s, i) => `${s.method ?? '*'} ${s.path.source} x${injected[i]?.hits() ?? 0}`).join(', ')}`)
    },
  })
  const hits = injected.reduce((sum, i) => sum + i.hits(), 0)
  await Promise.all(injected.map((i) => i.remove()))
  return { problems: withoutInjected(problems, ...c.injections), screenshot: record.screenshot, hits }
}

test.describe('error states (injected failures)', () => {
  for (const c of CASES) {
    test(c.step, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      test.skip(c.adminOnly === true && role !== 'admin', 'admin-only screen')
      const { problems, screenshot, hits } = await runCase(page, role, c)
      expect(hits, 'the injected route was called').toBeGreaterThan(0)
      expect(problems, `${c.step}: ${screenshot ?? ''}`).toEqual([])
    })
  }
})
