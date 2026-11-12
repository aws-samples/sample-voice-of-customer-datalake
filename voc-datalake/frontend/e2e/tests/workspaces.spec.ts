/**
 * Workspaces in the web app (docs/multi-workspace.md, Request flow), against the dev mock's two workspaces
 * (mock-workspaces.js: the caller is an admin of Acme Outfitters, slug acme, and an editor of Juniper Trail Co.,
 * slug juniper):
 *
 * 1. From `/` the picker lists both, with their roles, each linking into its own `/w/{slug}/`.
 * 2. Choosing Acme Outfitters from `/dashboard` lands on `/w/acme/dashboard`, the header names it, and every
 *    API call of the page carries acme's id in `X-Workspace-Id`.
 * 3. The header's workspace menu switches to Juniper Trail Co.: a full page load to `/w/juniper/dashboard`,
 *    whose calls carry juniper's id and never acme's.
 * 4. An unknown slug shows "Workspace not found" with the caller's own workspaces, and the app does not render.
 *
 * MOCK ONLY: it needs the mock's two fictional workspaces (a deployment's are made by its platform admins in the
 * platform console, workspace-admin.spec.ts). The spec turns the mock's workspaces on through its dev
 * switch (`PUT /__mock/workspaces`) and off again afterwards, so the other mock specs keep the app without
 * workspaces.
 *
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/workspaces.spec.ts
 */
import { expect, type Page, type Request } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { apiUrl, MOCK } from '../lib/env'
import { assertStep, roleOf, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'

/** common.json workspaces.* strings (English). */
const TEXT = {
  picker: 'Choose a workspace',
  notFound: 'Workspace not found',
  acme: 'Acme Outfitters',
  juniper: 'Juniper Trail Co.',
} as const

interface MockWorkspace { id: string; slug: string; name: string }

/** The mock's workspaces by slug, read from `GET /me/workspaces` (so the spec never copies an id). */
async function mockWorkspaces(): Promise<Record<string, MockWorkspace>> {
  const { status, body } = await apiCall('admin', 'GET', '/me/workspaces')
  expect(status).toBe(200)
  const rows = isRecord(body) && Array.isArray(body['workspaces']) ? body['workspaces'] : []
  return Object.fromEntries(rows.flatMap((row: unknown) => isRecord(row) && typeof row['id'] === 'string' && typeof row['slug'] === 'string'
    ? [[row['slug'], { id: row['id'], slug: row['slug'], name: String(row['name']) }]] : []))
}

/**
 * Every API request a document under `documentPath` (`/w/acme/`) sends from now on, the workspace list itself
 * left out (it names no workspace). Preflights are not page requests.
 */
function apiRequests(page: Page, documentPath: string): Request[] {
  const seen: Request[] = []
  const origin = new URL(apiUrl()).origin
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== origin || url.pathname === '/me/workspaces') return
    if (new URL(request.frame().url()).pathname.startsWith(documentPath)) seen.push(request)
  })
  return seen
}

/** The distinct X-Workspace-Id values of `requests` (`(none)` for a request without one). */
function workspaceIds(requests: readonly Request[]): string[] {
  return [...new Set(requests.map((request) => request.headers()['x-workspace-id'] ?? '(none)'))]
}

test.describe('workspaces', () => {
  test.skip(!MOCK, 'needs the mock\'s two fictional workspaces: dev mock only')
  test.describe.configure({ mode: 'serial' })

  let workspaces: Record<string, MockWorkspace> = {}

  test.beforeAll(async () => {
    expect((await apiCall('admin', 'PUT', '/__mock/workspaces', { enabled: true })).status).toBe(200)
    workspaces = await mockWorkspaces()
    expect(Object.keys(workspaces).sort()).toStrictEqual(['acme', 'juniper'])
  })

  test.afterAll(async () => {
    await apiCall('admin', 'PUT', '/__mock/workspaces', { enabled: false })
  })

  test('the picker lists both workspaces from /', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspaces-01-picker', async () => {
      await page.goto(site('/'), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: TEXT.picker })).toBeVisible()
      const links = page.getByRole('navigation', { name: 'Your workspaces' }).getByRole('link')
      await expect(links).toHaveCount(2)
      expect(await links.evaluateAll((items) => items.map((item) => [item.textContent, item.getAttribute('href')])))
        .toStrictEqual([[`${TEXT.acme}Admin`, '/w/acme/'], [`${TEXT.juniper}Editor`, '/w/juniper/']])
    })
  })

  test('choosing acme lands on /w/acme/dashboard, every call naming acme', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspaces-02-enter-acme', async () => {
      await page.goto(site('/dashboard'), { waitUntil: 'domcontentloaded' })
      const requests = apiRequests(page, '/w/acme/')
      await page.getByRole('link', { name: new RegExp(TEXT.acme) }).click()
      await page.waitForURL(/\/w\/acme\/dashboard$/)
      await expect(page.getByRole('button', { name: `Workspace: ${TEXT.acme}, Admin. Switch workspace` })).toBeVisible()
      await settle(page, 500)
      expect(requests.length).toBeGreaterThan(0)
      // One value, acme's: no call of the page went out without the header or with another workspace's.
      expect(workspaceIds(requests)).toStrictEqual([workspaces['acme']?.id])
    })
  })

  test('the header menu switches to juniper with a full page load', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspaces-03-switch', async () => {
      await page.goto(site('/w/acme/dashboard'), { waitUntil: 'domcontentloaded' })
      const trigger = page.getByRole('button', { name: `Workspace: ${TEXT.acme}, Admin. Switch workspace` })
      await trigger.click()
      const item = page.getByRole('menuitem', { name: new RegExp(TEXT.juniper) })
      await expect(item).toBeFocused()
      const requests = apiRequests(page, '/w/juniper/')
      // A full page load (a new document), not an in-app navigation: nothing cached for acme survives it.
      await Promise.all([page.waitForEvent('load'), item.press('Enter')])
      await page.waitForURL(/\/w\/juniper\/dashboard$/)
      await expect(page.getByRole('button', { name: `Workspace: ${TEXT.juniper}, Editor. Switch workspace` })).toBeVisible()
      await settle(page, 500)
      expect(requests.length).toBeGreaterThan(0)
      expect(workspaceIds(requests)).toStrictEqual([workspaces['juniper']?.id])
    })
  })

  test('an unknown slug shows the not-found page with the caller\'s own workspaces', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspaces-04-not-found', async () => {
      await page.goto(site('/w/globex/dashboard'), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: TEXT.notFound })).toBeVisible()
      await expect(page.getByRole('link', { name: new RegExp(TEXT.acme) })).toHaveAttribute('href', '/w/acme/')
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
    })
  })
})
