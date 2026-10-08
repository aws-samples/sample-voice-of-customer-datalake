/**
 * F2 (E2E-COVERAGE-GAPS.md §3): Edit on the /projects list. Both roles.
 *
 * Admin (owner, so edit + manage):
 * - When Edit is clicked on its card and name/description/visibility are changed
 *   and saved, Then `PUT /projects/{id}` (and `PUT …/visibility`) answer 2xx, the
 *   card shows the new name and badge, and `GET /projects/{id}` and the detail
 *   page agree.
 * - Escape and Cancel close the dialog without a PUT.
 *
 * User:
 * - A private project they are not a member of is not listed at all.
 * - On a private project they are a VIEWER of, the card has no Edit, and a forced
 *   `PUT /projects/{id}` is a 403.
 *
 * Data (admin API, ledger-recorded, so cleanup deletes them): `…-edit` (admin
 * edits it), `…-edit-viewer` (user invited as viewer), `…-edit-hidden` (private,
 * unshared). They stay separate so neither role's order can change what the
 * other sees.
 */
import { expect, type Page, type Request } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { RUN_PREFIX } from '../lib/env'
import { assertStep, isApi, roleOf, settle, site } from '../lib/fixtures'
import { dialogNamed } from '../lib/dialogs'
import { ensureE2eProject, inviteMember, projectCard, projectIdOrSkip, readProject } from '../lib/projects'

const NAME = {
  edited: `${RUN_PREFIX}edit`,
  viewer: `${RUN_PREFIX}edit-viewer`,
  hidden: `${RUN_PREFIX}edit-hidden`,
}
/** Keeps the e2e prefix, so the leftover sweep would still recognise it. */
const RENAMED = `${NAME.edited}-renamed`
const NEW_DESCRIPTION = 'Edited by the e2e suite from the Projects list.'



const card = projectCard

async function openList(page: Page): Promise<void> {
  await page.goto(site('/projects'), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
}

/** Every project PUT the page sends from now on (none expected when cancelling). */
function recordPuts(page: Page): Request[] {
  const puts: Request[] = []
  page.on('request', (request) => {
    if (isApi(request, 'PUT', /\/projects\/[^/]+(\/visibility)?$/)) puts.push(request)
  })
  return puts
}

test.describe('projects: Edit on the list', () => {
  test.beforeAll(async () => {
    await ensureE2eProject(NAME.edited, 'private')
    const viewerProject = await ensureE2eProject(NAME.viewer, 'private')
    await inviteMember(viewerProject, 'user', 'viewer')
    await ensureE2eProject(NAME.hidden, 'private')
  })

  test.describe('admin', () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(roleOf(testInfo) !== 'admin', 'admin owns these projects')
    })

    test('Escape and Cancel close the dialog without a PUT', async ({ page }) => {
      projectIdOrSkip(NAME.edited)
      await assertStep(page, 'admin', 'projects-edit-cancel', async (r) => {
        const puts = recordPuts(page)
        await openList(page)
        const edit = card(page, NAME.edited).getByRole('button', { name: `Edit project ${NAME.edited}` })
        await edit.click()
        const dialog = dialogNamed(page, 'Edit Project')
        await dialog.getByLabel('Project Name').fill(`${NAME.edited}-discarded`)
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        await edit.click()
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        await expect(dialog).toBeHidden()
        expect(puts, 'no PUT on Escape / Cancel').toHaveLength(0)
        await expect(card(page, NAME.edited)).toBeVisible()
        r.note('Escape and Cancel closed the dialog; no PUT sent')
      })
    })

    test('edits name, description and visibility; list, API and detail agree', async ({ page }) => {
      const id = projectIdOrSkip(NAME.edited)
      await assertStep(page, 'admin', 'projects-edit-save', async (r) => {
        await openList(page)
        await card(page, NAME.edited).getByRole('button', { name: `Edit project ${NAME.edited}` }).click()
        const dialog = dialogNamed(page, 'Edit Project')
        await dialog.getByLabel('Project Name').fill(RENAMED)
        await dialog.getByLabel('Description').fill(NEW_DESCRIPTION)
        await dialog.getByRole('radio', { name: /Public/ }).check()
        const fields = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/projects/${id}$`)))
        const visibility = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/projects/${id}/visibility$`)))
        await dialog.getByRole('button', { name: 'Save' }).click()
        const [fieldsRes, visibilityRes] = await Promise.all([fields, visibility])
        r.note(`PUT /projects/{id} -> ${fieldsRes.status()}, PUT …/visibility -> ${visibilityRes.status()}`)
        expect([fieldsRes.status(), visibilityRes.status()]).toEqual([200, 200])
        await expect(dialog).toBeHidden()
        await expect(card(page, RENAMED)).toContainText(NEW_DESCRIPTION)
        await expect(card(page, RENAMED)).toContainText('Public')

        const stored = await readProject('admin', id)
        expect(stored).toMatchObject({ status: 200, name: RENAMED, description: NEW_DESCRIPTION, visibility: 'public' })

        await page.goto(site(`/projects/${id}`), { waitUntil: 'domcontentloaded' })
        await expect(page.getByRole('heading', { level: 1, name: RENAMED })).toBeVisible()
      })
    })
  })

  test.describe('user', () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(roleOf(testInfo) !== 'user', 'the view-only checks run as e2e-user')
    })

    test('sees no Edit on a project they only view, and no unshared private project', async ({ page }) => {
      projectIdOrSkip(NAME.viewer)
      await assertStep(page, 'user', 'projects-edit-viewer-list', async (r) => {
        await openList(page)
        await expect(card(page, NAME.viewer)).toBeVisible()
        await expect(card(page, NAME.viewer).getByRole('button', { name: /^Edit project/ })).toHaveCount(0)
        await expect(card(page, NAME.hidden)).toHaveCount(0)
        r.note('viewer card has no Edit; the unshared private project is not listed')
      })
    })

    test('a forced PUT on a view-only project is refused with 403', async () => {
      const id = projectIdOrSkip(NAME.viewer)
      const forced = await apiCall('user', 'PUT', `/projects/${encodeURIComponent(id)}`, { name: `${NAME.viewer}-hijacked` })
      expect(forced.status).toBe(403)
      expect((await readProject('admin', id)).name).toBe(NAME.viewer)
    })
  })
})
