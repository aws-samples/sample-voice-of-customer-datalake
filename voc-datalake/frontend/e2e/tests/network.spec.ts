/**
 * P3 — bad networks (E2E-COVERAGE-GAPS I-11 / I-12), on three list screens and
 * the assistant. Read only, except the one assistant message (its conversation
 * is recorded in the ledger by lib/test.ts and deleted by cleanup).
 *
 * For /projects, /feedback-forms and /agents:
 * - slow 3G (Chromium emulation, after the shell loaded): the loading state
 *   shows, then the list; no error, no error boundary;
 * - the list request dropped (`route.abort`): an error state — never the
 *   "nothing here yet" empty state (components/LoadFailed on every list page) —
 *   then the page recovers on Try again once the network is back;
 * - offline (`context.setOffline`): a list already on screen stays on screen
 *   (no error replaces cached data); a page never loaded yet says it failed
 *   (the route error boundary or the page's error state, never a blank page) and
 *   recovers once back online.
 *
 * The assistant: the connection is cut mid-answer (the SPA receives the first
 * answer bytes, then the body ends), the panel says the connection closed, and a
 * reload recovers the SERVER's copy of the run: "Still generating…" while the run
 * is live, then the answer (the stream Lambda finishes and saves without a
 * client). The dev mock has no server-side run, so under E2E_MOCK its session
 * GET is answered as the stream Lambda would (running twice, then finished),
 * which checks the SPA half of the contract.
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { composer, conversationLog } from '../lib/assistant'
import { lastAssistantText, headWords, runStatusOf } from '../lib/assistantHealth'
import { MOCK, apiUrl } from '../lib/env'
import { isRecord } from '../lib/guards'
import { ERROR_BOUNDARY_TEXT, roleOf, settle, site } from '../lib/fixtures'
import { armStreamCut, emulateSlow3g, failApiGet, navigateInApp, streamCutAt } from '../lib/network'

interface ListScreen {
  name: string
  path: string
  /** The API list it loads. */
  api: string
  loading: (page: Page) => Locator
  error: (page: Page) => Locator
  /** Something only the loaded page shows (a row, or its empty state). */
  loaded: (page: Page) => Locator
  /** Brings the page back once the network is: Try again, or (no retry button) navigating away and back. */
  recover: (page: Page) => Promise<void>
}

const LOAD_FAILED = 'This could not be loaded. Check your connection and try again.'
/** agents.json list.loadFailed: the Agents page's LoadFailed names what failed. */
const AGENTS_FAILED = "Agents couldn't be loaded."
const failedAlert = (page: Page, text: string): Locator => page.getByRole('alert').filter({ hasText: text })
/** Recovery through the LoadFailed alert's own Try again. */
const tryAgainOn = (text: string) => async (page: Page): Promise<void> => {
  await failedAlert(page, text).getByRole('button', { name: 'Try again' }).click()
}
const tryAgain = tryAgainOn(LOAD_FAILED)
const main = (page: Page): Locator => page.locator('main')

const SCREENS: readonly ListScreen[] = [
  {
    name: 'projects', path: '/projects', api: '/projects',
    loading: (p) => main(p).locator('.skeleton'),
    error: (p) => failedAlert(p, LOAD_FAILED),
    loaded: (p) => main(p).getByRole('heading', { level: 2 }).or(main(p).getByText('No projects yet')),
    recover: tryAgain,
  },
  {
    name: 'feedback-forms', path: '/feedback-forms', api: '/feedback-forms',
    loading: (p) => main(p).getByRole('status', { name: 'Loading...' }),
    error: (p) => failedAlert(p, LOAD_FAILED),
    loaded: (p) => main(p).getByRole('button', { name: 'Edit form' }).or(main(p).getByText('No feedback forms yet')),
    recover: tryAgain,
  },
  {
    name: 'agents', path: '/agents', api: '/agents',
    loading: (p) => main(p).locator('.skeleton'),
    error: (p) => failedAlert(p, AGENTS_FAILED),
    loaded: (p) => main(p).locator('a[href^="/agents/"]').or(main(p).getByText('No autonomous agents yet')),
    recover: tryAgainOn(AGENTS_FAILED),
  },
]

/** Uncaught page errors, and whether the route error boundary ever rendered. */
function watchCrashes(page: Page): { pageErrors: string[]; boundary: () => Promise<boolean> } {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)))
  return { pageErrors, boundary: () => page.getByText(ERROR_BOUNDARY_TEXT, { exact: true }).isVisible() }
}

async function expectNotCrashed(page: Page, crashes: ReturnType<typeof watchCrashes>): Promise<void> {
  expect(crashes.pageErrors, 'no uncaught page error').toEqual([])
  expect(await crashes.boundary(), 'no route error boundary').toBe(false)
  await expect(page.getByRole('heading', { level: 1 }).first(), 'never a blank page').toBeVisible()
}

/**
 * The app shell is up on a page that loads none of the lists (the in-shell 404
 * page; Home would cache /projects and the forms list for its onboarding checks),
 * so later moves are in-app and need no network for the shell.
 */
const NEUTRAL_PAGE = '/e2e-no-such-page'

async function openShell(page: Page): Promise<void> {
  await page.goto(site(NEUTRAL_PAGE), { waitUntil: 'domcontentloaded' })
  await settle(page, 600)
}

/** Slow 3G through the Vite dev server is a waterfall of module requests: generous for the first paint. */
const SLOW_LOAD_MS = 90_000
/** TanStack's one retry after ~1 s (App.tsx `retry: 1`), plus the two failed round trips. */
const OFFLINE_REFRESH_SETTLE_MS = 2_500

test.describe('bad networks', () => {
  for (const screen of SCREENS) {
    test(`${screen.name}: slow 3G shows the loading state, then the list`, async ({ page }, testInfo) => {
      test.skip(screen.name === 'agents' && roleOf(testInfo) !== 'admin', 'one role is enough for /agents')
      const crashes = watchCrashes(page)
      await openShell(page)
      const lift = await emulateSlow3g(page)
      try {
        await navigateInApp(page, screen.path)
        await expect(screen.loading(page).first(), 'a loading state while the list is on its way').toBeVisible({ timeout: SLOW_LOAD_MS })
        await expect(screen.loaded(page).first(), 'then the list').toBeVisible({ timeout: SLOW_LOAD_MS })
        await expect(screen.error(page)).toHaveCount(0)
      } finally {
        await lift()
      }
      await expectNotCrashed(page, crashes)
    })

    test(`${screen.name}: a dropped list request shows an error state (not "empty"), then recovers`, async ({ page }) => {
      const crashes = watchCrashes(page)
      const failing = await failApiGet(page, screen.api)
      await page.goto(site(screen.path), { waitUntil: 'domcontentloaded' })
      await expect(screen.error(page), 'the failure is said').toBeVisible({ timeout: 20_000 })
      await expect(screen.loaded(page), 'no list and no "nothing here yet" while it failed').toHaveCount(0)
      await failing.restore()
      await screen.recover(page)
      await expect(screen.loaded(page).first(), 'recovered').toBeVisible({ timeout: 20_000 })
      await expect(screen.error(page)).toHaveCount(0)
      await expectNotCrashed(page, crashes)
    })

    test(`${screen.name}: offline (context.setOffline) keeps a loaded list on screen, without errors`, async ({ page, context }) => {
      const crashes = watchCrashes(page)
      await openShell(page)
      await navigateInApp(page, screen.path)
      await expect(screen.loaded(page).first()).toBeVisible({ timeout: 20_000 })
      await navigateInApp(page, NEUTRAL_PAGE)
      await context.setOffline(true)
      try {
        // Back to the list while offline: the cached list shows, the failed refresh says nothing alarming.
        await navigateInApp(page, screen.path)
        await expect(screen.loaded(page).first(), 'offline: the last list is still shown').toBeVisible()
        // Long enough for the background refresh and its one retry to fail.
        await page.waitForTimeout(OFFLINE_REFRESH_SETTLE_MS)
        await expect(screen.error(page), 'cached data is not replaced by an error').toHaveCount(0)
      } finally {
        await context.setOffline(false)
      }
      await expect(screen.loaded(page).first()).toBeVisible()
      await expectNotCrashed(page, crashes)
    })

    test(`${screen.name}: offline before the page ever loaded shows an error (never blank), then recovers online`, async ({ page, context }) => {
      const crashes = watchCrashes(page)
      await openShell(page)
      await context.setOffline(true)
      try {
        // Neither the page's code nor its list can be fetched: the route error
        // boundary ("Reload page") or the page's own error state, never a blank page.
        await navigateInApp(page, screen.path)
        const boundary = page.getByRole('alert').filter({ hasText: ERROR_BOUNDARY_TEXT })
        await expect(boundary.or(screen.error(page)).first(), 'offline: an error is said').toBeVisible({ timeout: 20_000 })
      } finally {
        await context.setOffline(false)
      }
      const reload = page.getByRole('button', { name: 'Reload page' })
      if (await reload.isVisible()) await reload.click()
      else await screen.recover(page)
      await expect(screen.loaded(page).first(), 'back online: recovered').toBeVisible({ timeout: 30_000 })
      expect(crashes.pageErrors, 'no uncaught page error').toEqual([])
    })
  }

  test('assistant: the connection cut mid-answer, then a reload recovers the server run', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'one role is enough (one Bedrock call per run)')
    test.setTimeout(240_000)
    const prompt = 'e2e network check: in two sentences, what is the most common complaint?'
    await armStreamCut(page)
    if (MOCK) await serveServerRunInMock(page, prompt)
    await page.goto(site('/chat'), { waitUntil: 'domcontentloaded' })
    const streamed = page.waitForRequest((r) => r.method() === 'POST' && /\/chat\/stream$/.test(new URL(r.url()).pathname))
    await composer(page).fill(prompt)
    await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).first().click()
    const threadId = threadIdOf((await streamed).postData())
    expect(threadId, 'the run names its conversation').not.toBe('')
    await expect.poll(() => streamCutAt(page), { timeout: 90_000, message: 'the stream was cut after its first answer bytes' }).not.toBeNull()
    await expect(page.getByRole('alert').filter({ hasText: /connection closed before the answer finished|Something went wrong/ }))
      .toBeVisible({ timeout: 20_000 })

    await page.reload({ waitUntil: 'domcontentloaded' })
    const log = conversationLog(page)
    await expect(log).toContainText(prompt, { timeout: 30_000 })
    // Live: "Still generating…" first. A fast run may already be finished by the reload.
    const generating = page.getByRole('status').filter({ hasText: 'Still generating…' })
    // The faked run is live for its first polls, so the mock must show it; production may already be done.
    if (MOCK) await expect(generating, 'a live server run reads "Still generating…"').toBeVisible()
    await expect(generating).toHaveCount(0, { timeout: 200_000 })
    await expect(page.getByRole('alert').filter({ hasText: /taking longer than expected|Something went wrong/ })).toHaveCount(0)

    const stored = await apiCall('admin', 'GET', `/chat/conversations/${encodeURIComponent(threadId)}`)
    expect(stored.status).toBe(200)
    if (!MOCK) expect(runStatusOf(stored.body), 'the server finished the run without a client').toBe('finished')
    // Under E2E_MOCK the "server copy" is the one the page route served (this API read bypasses it).
    const answer = MOCK ? MOCK_FULL_ANSWER : lastAssistantText(stored.body)
    expect(answer.length, 'a stored answer').toBeGreaterThan(20)
    await expect(log).toContainText(headWords(answer, 4))
  })
})

/** The `threadId` of a `/chat/stream` request body ('' when absent). */
function threadIdOf(postData: string | null): string {
  try {
    const body: unknown = JSON.parse(postData ?? '')
    return isRecord(body) && typeof body['threadId'] === 'string' ? body['threadId'] : ''
  } catch {
    return ''
  }
}

const MOCK_FULL_ANSWER = 'Delivery delays are the most common complaint in the mock data, ahead of product quality.'
/** How many polls the faked server run stays `running` for. */
const MOCK_RUNNING_POLLS = 2

/**
 * E2E_MOCK only: answers `GET /chat/conversations/{id}` the way the stream
 * Lambda's saves would — the run `running` (fresh `updatedAt`, a growing
 * revision) for the first polls, then `finished` with the whole answer. Saves
 * still reach the mock.
 */
async function serveServerRunInMock(page: Page, prompt: string): Promise<void> {
  let polls = 0
  const api = new URL(apiUrl())
  await page.route((url) => url.origin === api.origin && /\/chat\/conversations\/(?!_list)[^/]+$/.test(url.pathname), async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    polls += 1
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '')
    const running = polls <= MOCK_RUNNING_POLLS
    const now = new Date().toISOString()
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        id, kind: 'assistant', title: prompt.slice(0, 60), page: null, pendingInterrupts: [],
        messages: [
          { id: 'e2e-u1', role: 'user', content: prompt },
          { id: 'e2e-a1', role: 'assistant', content: running ? MOCK_FULL_ANSWER.slice(0, 18) : MOCK_FULL_ANSWER },
        ],
        createdAt: now, updatedAt: now, runStatus: running ? 'running' : 'finished', runId: 'e2e-run', revision: 10 + polls,
      }),
    })
  })
}
