/**
 * Project sharing (E2E-COVERAGE-GAPS.md R-projects, M-share): the admin shares
 * through the Share dialog; e2e-user, in a second browser context, sees exactly
 * what that grants. One test in the admin project, so the order (share → check →
 * remove → check) never depends on how Playwright schedules the two roles.
 *
 * 1. Public: admin sets a private e2e project Public in "Share …" → `PUT …/visibility`
 *    200; e2e-user lists it and `GET /projects/{id}` is 200.
 * 2. Viewer: admin invites e2e-user as "Can view" (search → Select → Invite →
 *    `POST …/members` 2xx); e2e-user sees the view-only banner and no write
 *    controls (no Edit on the card, no Import / Generate Personas, no New Document),
 *    and a forced `PUT /projects/{id}` is a 403.
 * 3. Remove: admin removes e2e-user (no confirm by design) → `DELETE …/members/{sub}`
 *    200; e2e-user's `GET /projects/{id}` is a 404 and the list no longer has it.
 *
 * Data: two `e2e-<run id>-share-*` projects made through the admin API and recorded
 * in the ledger (cleanup deletes them). Production-safe. Needs both real users, so
 * it skips on the dev mock.
 *   npx playwright test -c playwright.config.ts --project=admin tests/sharing.spec.ts
 */
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { prepareContext, test } from '../lib/test'
import { apiCall, listOf } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, RUN_PREFIX, storageStatePath } from '../lib/env'
import { isApi, roleOf, runStep, settle, site } from '../lib/fixtures'
import { ensureE2eProject, projectCard, readProject } from '../lib/projects'
import { cognitoSubFor, cognitoUsernameFor } from '../lib/session'
import type { StepRecorder } from '../lib/recorder'

const NAME = { public: `${RUN_PREFIX}share-public`, viewer: `${RUN_PREFIX}share-viewer` }
const VIEW_ONLY_BANNER = 'You have view-only access to this project.'

const card = projectCard

async function userContext(browser: Browser): Promise<BrowserContext> {
  return prepareContext(await browser.newContext({ storageState: storageStatePath('user'), viewport: { width: 1440, height: 900 } }), 'user')
}

async function step(page: Page, role: 'admin' | 'user', name: string, action: (r: StepRecorder) => Promise<void>): Promise<void> {
  const { record, problems } = await runStep({ page, role, theme: 'dark', step: name, action })
  expect(problems, `${name}: ${record.screenshot ?? ''}`).toEqual([])
}

/** Opens project `id` and its Share dialog (named after the project). */
async function openShare(page: Page, id: string, name: string): Promise<Locator> {
  await page.goto(site(`/projects/${id}`), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  const dialog = dialogNamed(page, `Share "${name}"`)
  await expect(dialog.getByRole('heading', { name: 'Members' })).toBeVisible()
  return dialog
}

async function openList(page: Page): Promise<void> {
  await page.goto(site('/projects'), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
}

test.describe('projects: sharing (admin shares, e2e-user sees it)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'drives both roles from the admin project')
    test.skip(MOCK, 'needs two real users')
  })

  test('public, viewer, removed', async ({ page, browser }) => {
    test.setTimeout(240_000)
    const publicId = await ensureE2eProject(NAME.public, 'private')
    const viewerId = await ensureE2eProject(NAME.viewer, 'private')
    const username = cognitoUsernameFor('user')
    const userSub = cognitoSubFor('user')
    const context = await userContext(browser)
    try {
      await shareScenario(page, await context.newPage(), { publicId, viewerId, username, userSub })
    } finally {
      await context.close()
    }
  })
})

interface Scenario { publicId: string; viewerId: string; username: string; userSub: string }

async function shareScenario(page: Page, userPage: Page, { publicId, viewerId, username, userSub }: Scenario): Promise<void> {
  await step(page, 'admin', 'share-make-public', async (r) => {
    const dialog = await openShare(page, publicId, NAME.public)
    const put = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/projects/${publicId}/visibility$`)))
    // A controlled radio: it turns checked once the PUT answers and the members refetch, so click, not check().
    await dialog.getByRole('radio', { name: 'Public' }).click()
    const status = (await put).status()
    r.note(`PUT …/visibility -> ${status}`)
    expect(status).toBe(200)
    await expect(dialog.getByRole('radio', { name: 'Public' })).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
  await step(userPage, 'user', 'share-public-visible', async () => {
    expect((await readProject('user', publicId)).status).toBe(200)
    await openList(userPage)
    await expect(card(userPage, NAME.public)).toBeVisible()
  })

  await step(page, 'admin', 'share-invite-viewer', async (r) => {
    const dialog = await openShare(page, viewerId, NAME.viewer)
    await dialog.getByLabel('Search users').fill(username)
    await dialog.getByRole('button', { name: `Select ${username}` }).click()
    await dialog.getByLabel('Role for the invited person').selectOption('viewer')
    const invited = page.waitForResponse((res) => isApi(res, 'POST', new RegExp(`/projects/${viewerId}/members$`)))
    await dialog.getByRole('button', { name: 'Invite', exact: true }).click()
    const status = (await invited).status()
    r.note(`POST …/members -> ${status}`)
    expect(status).toBeLessThan(300)
    await expect(dialog.getByRole('combobox', { name: `Role for ${username}` })).toHaveValue('viewer')
    await page.keyboard.press('Escape')
  })
  await step(userPage, 'user', 'share-viewer-read-only', async (r) => {
    await userPage.goto(site(`/projects/${viewerId}`), { waitUntil: 'domcontentloaded' })
    await expect(userPage.getByText(VIEW_ONLY_BANNER, { exact: false })).toBeVisible()
    await userPage.goto(site(`/projects/${viewerId}?tab=personas`), { waitUntil: 'domcontentloaded' })
    await settle(userPage, 800)
    for (const name of [/Import Persona/i, /Generate Personas/i]) await expect(userPage.getByRole('button', { name })).toHaveCount(0)
    await userPage.goto(site(`/projects/${viewerId}?tab=documents`), { waitUntil: 'domcontentloaded' })
    await settle(userPage, 800)
    await expect(userPage.getByRole('button', { name: /New Document/i })).toHaveCount(0)
    await openList(userPage)
    await expect(card(userPage, NAME.viewer)).toBeVisible()
    await expect(card(userPage, NAME.viewer).getByRole('button', { name: /^Edit project/ })).toHaveCount(0)
    const forced = await apiCall('user', 'PUT', `/projects/${encodeURIComponent(viewerId)}`, { name: `${NAME.viewer}-hijacked` })
    r.note(`forced PUT as a viewer -> ${forced.status}`)
    expect(forced.status).toBe(403)
    expect((await readProject('admin', viewerId)).name).toBe(NAME.viewer)
  })

  await step(page, 'admin', 'share-remove-member', async (r) => {
    const dialog = await openShare(page, viewerId, NAME.viewer)
    const removed = page.waitForResponse((res) => isApi(res, 'DELETE', new RegExp(`/projects/${viewerId}/members/[^/]+$`)))
    await dialog.getByRole('button', { name: `Remove ${username}` }).click()
    const status = (await removed).status()
    r.note(`DELETE …/members/{sub} -> ${status}`)
    expect(status).toBe(200)
    await expect(dialog.getByRole('button', { name: `Remove ${username}` })).toHaveCount(0)
    const members = await apiCall('admin', 'GET', `/projects/${encodeURIComponent(viewerId)}/members`)
    expect(listOf(members.body, 'members').some((m) => m['sub'] === userSub)).toBe(false)
    await page.keyboard.press('Escape')
  })
  await step(userPage, 'user', 'share-removed-gone', async () => {
    expect((await readProject('user', viewerId)).status).toBe(404)
    await openList(userPage)
    await expect(card(userPage, NAME.public)).toBeVisible()
    await expect(card(userPage, NAME.viewer)).toHaveCount(0)
  })
}
