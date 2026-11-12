/**
 * Managing workspaces in the web app (docs/multi-workspace.md, Control plane, Invites), against the dev mock's two
 * workspaces (mock-workspaces.js: the caller, admin-demo, a platform admin, is the admin of Acme Outfitters, slug
 * acme, and an editor of Juniper Trail Co., slug juniper):
 *
 * 1. The platform console (Administration → Privacy & access → Workspaces) creates "Acme Outfitters Field Team"
 *    (acme-field) and enters it: a full page load to `/w/acme-field/`, the header naming it with the Admin role.
 * 2. In acme, the members page adds editor@example.com as an Editor, makes them a Viewer, and the caller's own
 *    demotion (the only admin), confirmed first, is refused with the last-admin message.
 * 3. In juniper, where the caller is an editor, the list is read-only; Leave workspace, confirmed, loads `/`, which
 *    no longer offers juniper.
 * 4. The platform console enters juniper, which the caller is no longer a member of: the gate lets them in once the
 *    server answers it, as admin, and every call names juniper.
 *
 * MOCK ONLY: on a deployment these would create a workspace and change real memberships, and a workspace cannot be
 * deleted yet (phase 4). The mock's state lives in its process: the spec turns its workspaces on
 * (`PUT /__mock/workspaces`, which starts them afresh) and off again afterwards, so the other mock specs keep the app
 * without workspaces. The mock has no sign-in, so each page gets admin-demo's identity (its `sub`, which the members
 * page compares to find the caller's own row) in the app's stored session.
 *
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/workspace-admin.spec.ts
 */
import { expect, type Page, type Request } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { apiUrl, MOCK } from '../lib/env'
import { assertStep, roleOf, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'

/** common.json workspaces.* strings (English). */
const TEXT = {
  field: 'Acme Outfitters Field Team',
  acme: 'Acme Outfitters',
  juniper: 'Juniper Trail Co.',
  lastAdmin: 'A workspace needs an admin: make another member an admin first.',
} as const

/** The console's address inside acme (the gate shows the picker for an address without a workspace). */
const CONSOLE = '/w/acme/admin?tab=access&section=workspaces'

/** admin-demo as the app stores a signed-in user (`voc-auth`, store/authStore.ts): the mock caller's sub. */
async function signInAsMockCaller(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const user = { username: 'admin-demo', email: 'admin@example.com', name: 'Ada Admin', groups: ['admins', 'platform-admins'], sub: 'sub-admin-demo' }
    window.localStorage.setItem('voc-auth', JSON.stringify({ state: { user, accessToken: null, idToken: null, isAuthenticated: true }, version: 1 }))
  })
}

/** The id of the mock workspace `slug`, read from the platform list (so the spec never copies an id). */
async function workspaceId(slug: string): Promise<string> {
  const { status, body } = await apiCall('admin', 'GET', '/platform/workspaces')
  expect(status).toBe(200)
  const rows = isRecord(body) && Array.isArray(body['workspaces']) ? body['workspaces'] : []
  const row: unknown = rows.find((candidate: unknown) => isRecord(candidate) && candidate['slug'] === slug)
  return isRecord(row) && typeof row['id'] === 'string' ? row['id'] : ''
}

/** The distinct X-Workspace-Id values of the API requests a document under `documentPath` sends from now on. */
function workspaceIdsSent(page: Page, documentPath: string): () => string[] {
  const seen: Request[] = []
  const origin = new URL(apiUrl()).origin
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== origin || url.pathname === '/me/workspaces' || url.pathname.startsWith('/platform/')) return
    if (new URL(request.frame().url()).pathname.startsWith(documentPath)) seen.push(request)
  })
  return () => [...new Set(seen.map((request) => request.headers()['x-workspace-id'] ?? '(none)'))]
}

test.describe('workspace administration', () => {
  test.skip(!MOCK, 'creates workspaces and changes memberships, which a deployment cannot undo yet: dev mock only')
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    expect((await apiCall('admin', 'PUT', '/__mock/workspaces', { enabled: true })).status).toBe(200)
  })

  test.afterAll(async () => {
    await apiCall('admin', 'PUT', '/__mock/workspaces', { enabled: false })
  })

  test.beforeEach(async ({ page }) => {
    await signInAsMockCaller(page)
  })

  test('a platform admin creates a workspace and enters it', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-admin-01-create-enter', async () => {
      await page.goto(site(CONSOLE), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: 'Workspaces', level: 2 })).toBeVisible()
      await expect(page.getByRole('button', { name: `Enter ${TEXT.juniper}` })).toBeVisible()
      await page.getByLabel('Name').fill(TEXT.field)
      await page.getByLabel('Address (slug)').fill('acme-field')
      await page.getByRole('button', { name: 'Create workspace' }).click()
      await expect(page.getByRole('status')).toContainText(`Created ${TEXT.field}. You are its admin.`)
      await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: `Enter ${TEXT.field}` }).first().click()])
      await page.waitForURL(/\/w\/acme-field\/$/)
      await expect(page.getByRole('button', { name: `Workspace: ${TEXT.field}, Admin. Switch workspace` })).toBeVisible()
    })
  })

  test('an admin adds a member, changes the role, and is refused demoting the last admin', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-admin-02-members', async () => {
      await page.goto(site('/w/acme/members'), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: 'Members', level: 1 })).toBeVisible()
      await page.getByLabel('Email').fill('editor@example.com')
      await page.getByLabel('Role', { exact: true }).selectOption('editor')
      await page.getByRole('button', { name: 'Add member' }).click()
      await expect(page.getByRole('status')).toContainText('editor@example.com is now a member (Editor). No email was sent')
      await page.getByRole('combobox', { name: 'Role of Eddie Editor' }).selectOption('viewer')
      await expect(page.getByRole('status')).toContainText("Eddie Editor's role is now Viewer.")
      await page.getByRole('combobox', { name: 'Role of Ada Admin' }).selectOption('viewer')
      // Lowering your own role is confirmed first.
      await page.getByRole('dialog', { name: 'Lower your own role?' }).getByRole('button', { name: 'Make me Viewer' }).click()
      await expect(page.getByRole('alert')).toContainText(TEXT.lastAdmin)
    })
  })

  test('a member leaves a workspace and lands on the start page without it', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-admin-03-leave', async () => {
      await page.goto(site('/w/juniper/members'), { waitUntil: 'domcontentloaded' })
      await expect(page.getByText("Only the workspace's admins can add members, change roles or remove members.")).toBeVisible()
      await expect(page.getByRole('combobox')).toHaveCount(0)
      await page.getByRole('button', { name: 'Leave workspace' }).click()
      const dialog = page.getByRole('dialog', { name: 'Leave this workspace?' })
      await Promise.all([page.waitForURL(/\/$/), dialog.getByRole('button', { name: 'Leave workspace' }).click()])
      await expect(page.getByRole('heading', { name: 'Choose a workspace' })).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Your workspaces' }).getByRole('link', { name: new RegExp(TEXT.juniper) })).toHaveCount(0)
    })
  })

  test('a platform admin enters, from the console, a workspace they are not a member of', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-admin-04-platform-entry', async () => {
      const juniperId = await workspaceId('juniper')
      await page.goto(site(CONSOLE), { waitUntil: 'domcontentloaded' })
      const sent = workspaceIdsSent(page, '/w/juniper/')
      await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: `Enter ${TEXT.juniper}` }).click()])
      await page.waitForURL(/\/w\/juniper\/$/)
      await expect(page.getByRole('button', { name: `Workspace: ${TEXT.juniper}, Admin. Switch workspace` })).toBeVisible()
      // Every call the page has sent names juniper (one value), polled until the page's calls have gone out.
      await expect.poll(sent).toStrictEqual([juniperId])
    })
  })
})
