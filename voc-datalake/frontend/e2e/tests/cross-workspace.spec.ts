/**
 * The two-workspace check (docs/multi-workspace.md, Phases: a guard kept green from phase 1 on), against the dev
 * mock's two workspaces with the caller a member of Acme Outfitters only (mock-workspaces.js,
 * `PUT /__mock/workspaces {"enabled": true, "member": "acme"}`; the workspace routes then treat the caller as no
 * platform admin): the address `/w/juniper/members`, of a workspace the caller is not a member of, shows "Workspace
 * not found" with the caller's own workspace, and the app does not render.
 *
 * The API's side of the same rule, route by route, is lambda/api/test/test_cross_workspace.py. MOCK ONLY: a
 * deployment's workspaces are made by its platform admins. The switch is set for this spec only (each call starts
 * the mock's workspaces afresh) and off again afterwards, so the other mock specs keep the app without workspaces.
 *
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/cross-workspace.spec.ts
 */
import { expect } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { MOCK } from '../lib/env'
import { assertStep, roleOf, site } from '../lib/fixtures'

/** common.json workspaces.* strings (English). */
const TEXT = { notFound: 'Workspace not found', acme: 'Acme Outfitters' } as const

test.describe('cross-workspace', () => {
  test.skip(!MOCK, 'needs the mock\'s two fictional workspaces: dev mock only')

  test.beforeAll(async () => {
    expect((await apiCall('admin', 'PUT', '/__mock/workspaces', { enabled: true, member: 'acme' })).status).toBe(200)
  })

  test.afterAll(async () => {
    await apiCall('admin', 'PUT', '/__mock/workspaces', { enabled: false })
  })

  test('the address of a workspace the caller is not a member of shows not-found', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'cross-workspace-01-not-found', async () => {
      await page.goto(site('/w/juniper/members'), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: TEXT.notFound })).toBeVisible()
      await expect(page.getByRole('link', { name: new RegExp(TEXT.acme) })).toHaveAttribute('href', '/w/acme/')
      await expect(page.getByRole('heading', { name: 'Members', level: 1 })).toHaveCount(0)
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
    })
  })
})
