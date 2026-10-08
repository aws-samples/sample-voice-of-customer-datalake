/**
 * P3 — token expiry and "Session expired" (E2E-COVERAGE-GAPS I-14, R1).
 *
 * Each case runs in its OWN context built from the saved session, and never
 * writes that session back, so the rest of the run keeps its tokens.
 *
 * 1. Expired tokens in storage (id + access token `exp` an hour ago, in the
 *    app's `voc-auth` and in the Cognito SDK's own keys): the app refreshes
 *    silently on boot — the page renders, the stored id token is a NEW one that
 *    is not expired, and the API answers. Never a blank page.
 * 2. Expired tokens AND no refresh token: the refresh cannot succeed, so the app
 *    ends the session WITH its reason — `/login?expired=1` and "Session expired.
 *    Please login again." — never a bare login form, never a blank page. No
 *    refresh token is left to revoke, so this cannot touch the saved session.
 * 3. A 401 mid-session (one API call answered 401): the client refreshes once,
 *    retries, and the page shows its data — no logout.
 * 4. `/login?expired=1` itself shows the notice (also against the dev mock).
 *
 * Production only for 1–3: the dev mock has no Cognito (DEV treats the session
 * as an admin), so there is nothing to expire.
 */
import { expect, type BrowserContext, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { MOCK, apiUrl, storageStatePath } from '../lib/env'
import { isApi, roleOf, settle, site } from '../lib/fixtures'
import { anonymousContext, roleContext } from '../lib/mode'

const EXPIRED_NOTICE = 'Session expired. Please login again.'
/** sessionStorage flag: the tokens were tampered with once (an init script runs on every load). */
const DONE_FLAG = 'e2e-tokens-expired'

/**
 * Before the SPA boots, once per tab: every stored JWT (the app's `voc-auth`
 * and the SDK's `CognitoIdentityServiceProvider.*.{id,access}Token`) gets an
 * `exp` an hour in the past. The signature no longer matches, which is fine: the
 * client only decodes, and an expired token is never sent anyway. With
 * `dropRefresh` the SDK's refresh token is removed too.
 */
async function expireStoredTokens(context: BrowserContext, options: { dropRefresh: boolean }): Promise<void> {
  await context.addInitScript(({ flag, dropRefresh }: { flag: string; dropRefresh: boolean }) => {
    if (window.sessionStorage.getItem(flag) !== null) return
    window.sessionStorage.setItem(flag, '1')
    const toB64 = (text: string): string => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const fromB64 = (part: string): string => atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const expire = (jwt: string): string => {
      const [head, payload, signature] = jwt.split('.')
      if (head === undefined || payload === undefined || signature === undefined) return jwt
      const claims: unknown = JSON.parse(fromB64(payload))
      if (typeof claims !== 'object' || claims === null) return jwt
      return [head, toB64(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) - 3600 })), signature].join('.')
    }
    for (const key of Object.keys(window.localStorage)) {
      const value = window.localStorage.getItem(key) ?? ''
      if (/^CognitoIdentityServiceProvider\..+\.(idToken|accessToken)$/.test(key)) window.localStorage.setItem(key, expire(value))
      if (dropRefresh && /^CognitoIdentityServiceProvider\..+\.refreshToken$/.test(key)) window.localStorage.removeItem(key)
    }
    const raw = window.localStorage.getItem('voc-auth')
    if (raw === null) return
    const blob: unknown = JSON.parse(raw)
    if (typeof blob !== 'object' || blob === null || !('state' in blob)) return
    const state: unknown = blob.state
    if (typeof state !== 'object' || state === null) return
    const next: Record<string, unknown> = { ...state }
    for (const field of ['idToken', 'accessToken']) {
      const token = next[field]
      if (typeof token === 'string' && token !== '') next[field] = expire(token)
    }
    window.localStorage.setItem('voc-auth', JSON.stringify({ ...blob, state: next }))
  }, { flag: DONE_FLAG, dropRefresh: options.dropRefresh })
}

/** `exp` (epoch seconds) of the id token the app holds in `voc-auth`, or null. */
async function storedIdTokenExp(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    try {
      const blob: unknown = JSON.parse(window.localStorage.getItem('voc-auth') ?? 'null')
      const state: unknown = typeof blob === 'object' && blob !== null && 'state' in blob ? blob.state : null
      const token: unknown = typeof state === 'object' && state !== null && 'idToken' in state ? state.idToken : null
      if (typeof token !== 'string') return null
      const payload = token.split('.')[1] ?? ''
      const claims: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
      const exp: unknown = typeof claims === 'object' && claims !== null && 'exp' in claims ? claims.exp : null
      return typeof exp === 'number' ? exp : null
    } catch {
      return null
    }
  })
}

test.describe('session expiry', () => {
  test('expired tokens in storage: a silent refresh on boot, never a blank page', async ({ browser }, testInfo) => {
    test.skip(MOCK, 'the dev mock has no Cognito session to expire')
    const role = roleOf(testInfo)
    const context = await roleContext(browser, role, storageStatePath(role))
    try {
      await expireStoredTokens(context, { dropRefresh: false })
      const page = await context.newPage()
      const answered = page.waitForResponse((r) => isApi(r, 'GET', /\/projects$/), { timeout: 45_000 })
      await page.goto(site('/projects'), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible({ timeout: 30_000 })
      expect(new URL(page.url()).pathname).toBe('/projects')
      expect((await answered).status(), 'the API accepted the refreshed token').toBe(200)
      const exp = await storedIdTokenExp(page)
      expect(exp, 'a new id token').not.toBeNull()
      expect(exp ?? 0, 'that is not expired').toBeGreaterThan(Math.floor(Date.now() / 1000))
    } finally {
      await context.close()
    }
  })

  test('expired tokens and no refresh token: "Session expired" on the login page, never a blank page', async ({ browser }, testInfo) => {
    test.skip(MOCK, 'the dev mock has no Cognito session to expire')
    const role = roleOf(testInfo)
    const context = await roleContext(browser, role, storageStatePath(role))
    try {
      await expireStoredTokens(context, { dropRefresh: true })
      const page = await context.newPage()
      await page.goto(site('/projects'), { waitUntil: 'domcontentloaded' })
      await expect(page).toHaveURL(/\/login\?expired=1/, { timeout: 30_000 })
      await expect(page.getByRole('alert').filter({ hasText: EXPIRED_NOTICE })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('a 401 mid-session: one refresh and a retry, the data shows, no logout', async ({ browser }, testInfo) => {
    test.skip(MOCK, 'the dev mock has no Cognito session to refresh')
    const role = roleOf(testInfo)
    const context = await roleContext(browser, role, storageStatePath(role))
    try {
      const page = await context.newPage()
      let refused = 0
      await page.route((url) => isApiPath(url, /\/projects$/), async (route) => {
        if (route.request().method() !== 'GET' || refused > 0) return route.fallback()
        refused += 1
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Unauthorized' }) })
      })
      const retried = page.waitForResponse((r) => isApi(r, 'GET', /\/projects$/) && r.status() === 200, { timeout: 45_000 })
      await page.goto(site('/projects'), { waitUntil: 'domcontentloaded' })
      await retried
      expect(refused, 'the first read was refused').toBe(1)
      await settle(page, 500)
      expect(new URL(page.url()).pathname, 'still signed in').toBe('/projects')
      await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
      await expect(page.getByRole('alert').filter({ hasText: /could not be loaded|Session expired/ })).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('/login?expired=1 explains why the user is there (signed out)', async ({ browser }) => {
    const context = await anonymousContext(browser, { width: 1440, height: 900 })
    try {
      const page = await context.newPage()
      await page.goto(site('/login?expired=1'), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('alert').filter({ hasText: EXPIRED_NOTICE })).toBeVisible()
    } finally {
      await context.close()
    }
  })
})

/** The suite's API host and a path matching `pattern` (route predicate). */
function isApiPath(url: URL, pattern: RegExp): boolean {
  return url.origin === new URL(apiUrl()).origin && pattern.test(url.pathname)
}
