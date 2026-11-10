/**
 * The standalone feature-request board, `/board/*` (pages/Board, docs/feature-requests.md).
 *
 * 1. With the app session, `/board/sales-feature-requests` shows the seeded board (its request list): in the
 *    board shell when the deployment has a board pool, or — without one — after the redirect to the in-app
 *    `/feature-requests/sales-feature-requests` (Board.tsx). On the dev mock there is NO app session in the auth
 *    store (the DEV bypass lives in ProtectedRoute only), so `/board/...` shows the dev "Feedback boards are not
 *    enabled" notice; the mock run asserts that notice and then the same list in the app.
 * 2. `/board/login` in an anonymous context renders the email form ("Work email", "Email me a sign-in link").
 * 3. An email on a domain the board refuses (`…@example.org`) shows "This email’s domain is not allowed on
 *    the board", and the page stays on the email step (no code field).
 *
 * Steps 2–3 need a board pool: `board` in the runtime config (`/config.json`, src/runtimeConfig.ts →
 * getBoardPoolConfig → getBoardAuth). PRODUCTION reads the deployed `/config.json` and SKIPS them (with the
 * reason) when it has no `board` block. On the MOCK there is no `/config.json`, so the spec serves one with a
 * fake board pool and answers the Cognito endpoint itself; no request leaves the browser for AWS.
 *
 * Where the refusal happens (read in the code): SERVER-SIDE. The SPA checks only the email's shape
 * (utils/looksLikeEmail.ts, called by services/boardAuth.ts), then calls Cognito `SignUp`; the board pool's PreSignUp trigger
 * (lambda/auth/board_triggers.py `pre_sign_up_handler`) raises `domain_not_allowed` unless the domain is in
 * the engagement settings' `company_domains`, so Cognito creates no user and sends nothing (a refused
 * SignUp sends no verification message). The code email goes out only from the NEXT call, `InitiateAuth`
 * (EMAIL_OTP), which `requestCode` never reaches after a refused SignUp. Two guards keep it that way in
 * production: the step skips unless the admin's `GET /participants/settings` shows `example.org` is NOT an
 * allowed domain, and every Cognito call other than SignUp is aborted in the browser and fails the step.
 * `example.org` is an IANA-reserved domain, never a real mailbox.
 *
 * Mock run:
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:5482 E2E_API=http://127.0.0.1:3482 \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/board.spec.ts
 */
import { expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { MOCK, RUN_PREFIX, apiUrl } from '../lib/env'
import { assertStep, roleOf, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { anonymousContext } from '../lib/mode'
import { e2eFetch } from '../lib/trafficTag'

const REFUSED_DOMAIN = 'example.org'
const REFUSED_EMAIL = `${RUN_PREFIX}board@${REFUSED_DOMAIN}`
const NOT_ALLOWED = /domain is not allowed on the board/
const LOGIN_TITLE = 'Sign in to the feature-request board'
const COGNITO = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\//
const SIGN_UP = 'AWSCognitoIdentityProviderService.SignUp'

/** The runtime config the mock run serves: the mock API, a fake app pool and a fake board pool. */
const MOCK_CONFIG = {
  apiEndpoint: '',
  cognito: {
    userPoolId: 'us-east-1_e2eAppMock',
    clientId: 'e2eappmockclient',
    region: 'us-east-1',
  },
  board: { userPoolId: 'us-east-1_e2eBoardMock', clientId: 'e2eboardmockclient' },
}

/** What Cognito answers when PreSignUp raises `domain_not_allowed` (boardAuth.ts `boardAuthErrorFor`). */
const PRE_SIGN_UP_REFUSAL = {
  __type: 'UserLambdaValidationException',
  message: 'PreSignUp failed with error domain_not_allowed.',
}

const listRegion = (page: Page) => page.getByRole('region', { name: 'Requests' })
/** The seeded board every pre-boards request belongs to. */
const SALES_SLUG = 'sales-feature-requests'

/** Does the deployed runtime config carry a board pool (the same check as runtimeConfig.ts's schema)? */
async function deployedBoardPool(): Promise<boolean> {
  const response = await e2eFetch(site('/config.json'), { cache: 'no-store' }).catch(() => null)
  if (response === null || !response.ok) return false
  const body: unknown = await response.json().catch(() => null)
  const board = isRecord(body) ? body['board'] : undefined
  return isRecord(board) && typeof board['userPoolId'] === 'string' && board['userPoolId'] !== ''
    && typeof board['clientId'] === 'string' && board['clientId'] !== ''
}

/** The deployment's allowed board domains (admin read; [] when unreadable). */
async function companyDomains(): Promise<string[] | null> {
  const result = await apiCall('admin', 'GET', '/participants/settings')
  if (result.status !== 200 || !isRecord(result.body) || !isRecord(result.body['settings'])) return null
  const domains = result.body['settings']['company_domains']
  return Array.isArray(domains) ? domains.filter((d): d is string => typeof d === 'string') : null
}

/**
 * Every Cognito call of `context`, by its `X-Amz-Target`. SignUp is answered with the PreSignUp refusal on
 * the mock and let through in production; anything else (InitiateAuth would email a code) is aborted.
 */
async function guardCognito(context: BrowserContext): Promise<{ targets: string[] }> {
  const seen: { targets: string[] } = { targets: [] }
  await context.route(COGNITO, async (route: Route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }
    const target = request.headers()['x-amz-target'] ?? ''
    seen.targets.push(target)
    if (target !== SIGN_UP) {
      await route.abort('blockedbyclient')
      return
    }
    if (!MOCK) {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/x-amz-json-1.1' },
      body: JSON.stringify(PRE_SIGN_UP_REFUSAL),
    })
  })
  return seen
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

/** An anonymous context with a board pool: the deployed one, or (mock) a served config. Null = no pool. */
async function boardContext(browser: Browser): Promise<BrowserContext | null> {
  if (!MOCK && !(await deployedBoardPool())) return null
  const context = await anonymousContext(browser)
  if (MOCK) {
    const config = { ...MOCK_CONFIG, apiEndpoint: apiUrl() }
    await context.route(site('/config.json'), (route) => route.fulfill({ json: config }))
  }
  return context
}

async function openLogin(page: Page): Promise<void> {
  await page.goto(site('/board/login'), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: LOGIN_TITLE, level: 1 })).toBeVisible()
}

test.describe('the public feature-request board', () => {
  test('with the app session /board shows the board and its requests', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    await assertStep(page, role, 'board-01-app-session', async (r) => {
      await page.goto(site(`/board/${SALES_SLUG}`), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      if (MOCK) {
        // No app session in the store and no board pool: the dev notice, then the in-app board.
        await expect(page.getByRole('heading', { name: 'Feedback boards are not enabled', level: 1 })).toBeVisible()
        await expect(page.getByText(/Local development without a board pool/)).toBeVisible()
        await page.goto(site(`/feature-requests/${SALES_SLUG}`), { waitUntil: 'domcontentloaded' })
      }
      await expect(listRegion(page)).toBeVisible()
      const items = listRegion(page).getByRole('listitem')
      const empty = listRegion(page).getByText('No requests yet. Add the first one.')
      await expect(items.first().or(empty)).toBeVisible()
      const path = new URL(page.url()).pathname
      r.note(`board at ${path}: ${await items.count()} request(s)`)
      if (!MOCK) expect([`/board/${SALES_SLUG}`, `/feature-requests/${SALES_SLUG}`]).toContain(path)
      if (MOCK) expect(await items.count(), 'the mock seeds requests').toBeGreaterThan(0)
    })
  })

  test('/board/login, anonymous: the email form, and a refused domain says it is not allowed', async ({ browser }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'public page: one role is enough (the admin reads the domain settings)')
    const context = await boardContext(browser)
    test.skip(context === null, 'this deployment has no board pool (no `board` in /config.json)')
    if (context === null) return
    try {
      const page = await context.newPage()
      const cognito = await guardCognito(context)

      await assertStep(page, 'user', 'board-02-login-form', async () => {
        await openLogin(page)
        await expect(page.getByLabel('Work email')).toBeVisible()
        await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeDisabled()
        expect(new URL(page.url()).pathname).toBe('/board/login')
      })

      if (!MOCK) {
        const domains = await companyDomains()
        test.skip(domains === null, 'the engagement settings are unreadable: cannot prove the domain is refused')
        test.skip(domains?.some((domain) => domain === REFUSED_DOMAIN) === true, `${REFUSED_DOMAIN} is an allowed board domain here`)
      }

      await assertStep(page, 'user', 'board-03-domain-refused', async (r) => {
        await page.getByLabel('Work email').fill(REFUSED_EMAIL)
        await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
        await expect(page.getByRole('alert').filter({ hasText: NOT_ALLOWED })).toBeVisible()
        await expect(page.getByLabel('Code from the email')).toHaveCount(0)
        await expect(page.getByLabel('Work email')).toBeVisible()
        expect(cognito.targets, 'only SignUp reached Cognito (no InitiateAuth, so no code email)').toEqual([SIGN_UP])
        r.note(`refused ${REFUSED_DOMAIN}; Cognito calls: ${cognito.targets.join(', ')}`)
      })
    } finally {
      await context.close()
    }
  })

  test('/board/login without a board pool explains the board is not enabled', async ({ browser }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'public page: one role is enough')
    test.skip(!MOCK && (await deployedBoardPool()), 'this deployment has a board pool')
    const context = await anonymousContext(browser)
    try {
      const page = await context.newPage()
      await assertStep(page, 'user', 'board-04-no-pool', async () => {
        await page.goto(site('/board/login'), { waitUntil: 'domcontentloaded' })
        await expect(page.getByRole('heading', { name: 'Feedback boards are not enabled', level: 1 })).toBeVisible()
        await expect(page.getByLabel('Work email')).toHaveCount(0)
      })
    } finally {
      await context.close()
    }
  })
})
