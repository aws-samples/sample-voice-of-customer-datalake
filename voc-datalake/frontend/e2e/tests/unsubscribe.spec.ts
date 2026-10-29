/**
 * The public unsubscribe page (`/unsubscribe?t=<token>`, pages/Unsubscribe,
 * docs/participants.md), in a context with NO session at all (`anonymousContext`).
 *
 * 1. Without a token the page renders and says the link is incomplete; no button, no POST.
 * 2. With an obviously invalid token: nothing is posted on load (mail scanners fetch
 *    every link, so the person must press the button); pressing Unsubscribe sends ONE
 *    `POST /unsubscribe`, the route answers 200 (it always does: no existence leak), and
 *    the page shows the generic "You are unsubscribed" — never the token, an email
 *    address or error/stack text, and the API answer does not echo the token either.
 *
 * Production-safe: the only POST carries a garbage token (`e2e-invalid-<run id>-…`)
 * that names no person, so nobody is unsubscribed. The same on the dev mock (its
 * tokens are `unsub_<person_id>`; anything else is accepted silently). Runs once
 * (admin project): the page has no role.
 *
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:5481 E2E_API=http://127.0.0.1:3481 \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/unsubscribe.spec.ts
 */
import { expect, type Browser, type Page, type Request } from '@playwright/test'
import { test } from '../lib/test'
import { RUN_ID } from '../lib/env'
import { isApi, roleOf, runStep, settle, site } from '../lib/fixtures'
import { anonymousContext } from '../lib/mode'

/** Not a token the API could ever have issued: no person is behind it. */
const GARBAGE_TOKEN = `e2e-invalid-${RUN_ID}-not-a-token`
const INCOMPLETE = 'This link is incomplete. Use the unsubscribe link in the email you received.'
/** What must never be on the page: an email address, a stack or error dump. */
const LEAKS: ReadonlyArray<readonly [string, RegExp]> = [
  ['an email address', /[\w.+-]+@[\w-]+\.[\w.]+/],
  ['a stack trace', /\bat \S+ \(|Traceback|\.tsx?:\d+|\.py", line/],
  ['an error dump', /\b(TypeError|ReferenceError|Exception|Internal Server Error|undefined|null)\b/],
]

/** Opens `/unsubscribe` in a fresh anonymous context and counts every `POST /unsubscribe` it sends. */
async function openAnonymous(browser: Browser, query: string): Promise<{ page: Page; posts: Request[]; close: () => Promise<void> }> {
  const context = await anonymousContext(browser)
  const page = await context.newPage()
  const posts: Request[] = []
  page.on('request', (request) => { if (isApi(request, 'POST', /\/unsubscribe$/)) posts.push(request) })
  await page.goto(site(`/unsubscribe${query}`), { waitUntil: 'domcontentloaded' })
  return { page, posts, close: () => context.close() }
}

async function expectNoLeak(page: Page): Promise<void> {
  const text = await page.locator('body').innerText()
  expect(text.includes(GARBAGE_TOKEN), 'the token is not echoed').toBe(false)
  for (const [what, pattern] of LEAKS) expect(text, `no ${what} on the page`).not.toMatch(pattern)
}

test.describe('public unsubscribe page', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'public page: one run is enough')
  })

  test('without a token it says the link is incomplete and posts nothing', async ({ browser }) => {
    const { page, posts, close } = await openAnonymous(browser, '')
    try {
      const { record, problems } = await runStep({
        page, role: 'user', theme: 'dark', step: 'unsubscribe-no-token',
        action: async () => {
          await expect(page.getByRole('heading', { name: 'Unsubscribe', level: 1 })).toBeVisible()
          await expect(page.getByText(INCOMPLETE, { exact: true })).toBeVisible()
          await expect(page.getByRole('button', { name: 'Unsubscribe' })).toHaveCount(0)
          // Public: no redirect to /login.
          expect(new URL(page.url()).pathname).toBe('/unsubscribe')
          await settle(page, 500)
          expect(posts, 'no POST without a token').toHaveLength(0)
          await expectNoLeak(page)
        },
      })
      expect(problems, record.screenshot ?? '').toEqual([])
    } finally {
      await close()
    }
  })

  test('an invalid token posts only on confirm and shows the generic answer, leaking nothing', async ({ browser }) => {
    const { page, posts, close } = await openAnonymous(browser, `?t=${encodeURIComponent(GARBAGE_TOKEN)}`)
    try {
      const { record, problems } = await runStep({
        page, role: 'user', theme: 'dark', step: 'unsubscribe-invalid-token',
        action: async (recorder) => {
          await expect(page.getByRole('heading', { name: 'Unsubscribe', level: 1 })).toBeVisible()
          await expect(page.getByText(/Nothing changes until you do/)).toBeVisible()
          expect(new URL(page.url()).pathname).toBe('/unsubscribe')
          await settle(page, 1000)
          expect(posts, 'no POST on page load').toHaveLength(0)
          await expectNoLeak(page)

          const answered = page.waitForResponse((r) => isApi(r, 'POST', /\/unsubscribe$/))
          await page.getByRole('button', { name: 'Unsubscribe' }).click()
          const response = await answered
          expect(response.status(), 'the route always answers 200').toBe(200)
          const body = await response.text()
          expect(body.includes(GARBAGE_TOKEN), 'the API does not echo the token').toBe(false)
          expect(response.request().headers()['authorization'], 'no session header').toBeUndefined()
          recorder.note(`answer bytes: ${body.length}`)

          const done = page.getByRole('status').filter({ has: page.getByRole('heading', { name: 'You are unsubscribed' }) })
          await expect(done).toBeVisible()
          await expect(done).toContainText('You will not receive requests for feedback from us any more.')
          await expect(page.getByRole('button', { name: 'Unsubscribe' })).toHaveCount(0)
          expect(posts, 'exactly one POST').toHaveLength(1)
          await expectNoLeak(page)
        },
      })
      expect(problems, record.screenshot ?? '').toEqual([])
    } finally {
      await close()
    }
  })
})
