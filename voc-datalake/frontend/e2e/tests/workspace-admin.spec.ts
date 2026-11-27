/**
 * Managing workspaces in the web app (docs/multi-workspace.md, Control plane, Invites), against the dev mock's two
 * workspaces (mock-workspaces.js: the caller, admin-demo, a platform admin, is the admin of Acme Outfitters, slug
 * acme, and an editor of Juniper Trail Co., slug juniper):
 *
 * 1. The platform console (Administration → Workspaces → All workspaces, `/admin/workspaces/all`) creates "Acme Outfitters Field Team"
 *    (acme-field) and enters it: a full page load to `/workspace/acme-field/`, the header naming it with the Admin role.
 * 2. In acme, the members page adds editor@example.com as an Editor, makes them a Viewer, and the caller's own
 *    demotion (the only admin), confirmed first, is refused with the last-admin message.
 * 3. In juniper, where the caller is an editor, the list is read-only; Leave workspace, confirmed, loads `/`, which
 *    no longer offers juniper.
 * 4. The platform console enters juniper, which the caller is no longer a member of: the gate lets them in once the
 *    server answers it, as admin, and every call names juniper.
 * 5. In acme, Workspace settings (the workspace menu) saves acme's brand, not the deployment's, and lists the
 *    deployment's plugins; Enable turns Web Scraper on for acme (the list reads it back as On, with Disable), and
 *    Disable turns it off again.
 * 6. The platform console, inside acme, edits the deployment's default brand: the save names no workspace, and the
 *    deployment's brand (read without the header) has the new name; the spec puts the old one back.
 * 7. In acme, Workspace settings → "Workspace name" → Rename (7.40.00): a blank name cannot be saved and a name over
 *    80 characters is refused in the dialog, neither sending anything; a good one is one `PUT /me/workspaces/current`
 *    carrying acme's `X-Workspace-Id`, and the card and the header's workspace menu show the new name while the
 *    address stays `/workspace/acme/` (the slug never changes). The spec puts the old name back.
 * 8. Workspace settings → "Delete workspace" (7.40.00) on a workspace the spec creates for it (acme-popup): the
 *    dialog's Delete stays disabled until the slug is typed exactly, a reason is given and "I understand" is ticked;
 *    the delete is one `POST /me/workspaces/current/delete` (`confirm_slug`, `legal_basis`) with its id, the last
 *    dialog says it is being deleted, "Go to my workspaces" is a full page load to `/` that no longer offers it, and
 *    `/workspace/acme-popup/` is "Workspace not found" (its `GET /me/workspaces/current` a 404).
 * 9. The S3 import explorer follows its place (7.88.00): in acme (Administration → Sources, the S3 import card) it
 *    starts empty, and an upload asks for its URL with acme's `X-Workspace-Id` and lists the file; a second workspace
 *    the spec creates (acme-depot, the caller its admin) lists none of it; the platform admin's deployment view inside
 *    acme (`?scope=deployment`) reads without the header and lists the deployment's seeded files, not acme's.
 *
 * MOCK ONLY: on a deployment these would create a workspace and change real memberships (the deployment-side
 * lifecycle, which deletes what it made, is workspace-lifecycle.spec.ts). The mock's state lives in its process: the
 * spec turns its workspaces on (`PUT /__mock/workspaces`, which starts them afresh) and off again afterwards, which
 * also drops the rename, the extra workspaces and the delete, so the other mock specs keep the app without
 * workspaces. The mock has no sign-in, so each page gets admin-demo's identity (its `sub`, which the members page
 * compares to find the caller's own row) in the app's stored session. Step 8 needs the dev server started with
 * `VITE_ENABLE_WORKSPACE_DELETE=true` (the dev mock's `features.workspaceDelete`; the repo root's
 * scripts/dev-with-mock.mjs sets it), else the page offers no delete and the step fails saying so.
 *
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/workspace-admin.spec.ts
 */
import { expect, type Page, type Request } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { apiUrl, MOCK } from '../lib/env'
import { assertStep, escapeRegExp, roleOf, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'

/** common.json workspaces.* strings (English). */
const TEXT = {
  field: 'Acme Outfitters Field Team',
  acme: 'Acme Outfitters',
  juniper: 'Juniper Trail Co.',
  lastAdmin: 'A workspace needs an admin: make another member an admin first.',
  acmeBrand: 'Acme Outfitters Trail Gear',
  deploymentBrand: 'Acme Outfitters Basecamp',
  renamed: 'Acme Outfitters Trail Co-op',
  popup: 'Acme Outfitters Pop-up',
  deleteReason: 'Pop-up season over, ticket #2207',
  depot: 'Acme Outfitters Depot',
  noImportFiles: 'No files found',
} as const

/** The workspace step 8 creates and deletes (mock-workspaces.js: platform admins create one). */
const POPUP_SLUG = 'acme-popup'

/** The workspace step 9 creates: a second place of the caller's, as its admin. */
const DEPOT_SLUG = 'acme-depot'
/** Administration → Sources, the S3 import card opened (adminPaths.ts `/admin/sources/plugins/<source>`). */
const S3_IMPORT_CARD = '/admin/sources/plugins/s3_import'
/** The file step 9 uploads in acme, and one of the deployment's seeded files (mock-sources.js). */
const IMPORT_FILE = 'acme-ridge-notes.csv'
const DEPLOYMENT_IMPORT_FILE = 'june_reviews.csv'

/** platformWorkspacesApi.ts WORKSPACE_NAME_MAX (platform_workspaces.py validated_workspace_name). */
const NAME_MAX = 80

/** The console's address inside acme (the gate shows the picker for an address without a workspace): Administration →
 * Platform (7.54.00; Privacy & access → Workspaces before), its Workspaces card and the Deployment brand card. */
const CONSOLE = '/workspace/acme/admin/workspaces/all'

/** admin-demo as the app stores a signed-in user (`voc-auth`, store/authStore.ts): the mock caller's sub. */
async function signInAsMockCaller(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const user = { username: 'admin-demo', email: 'admin@example.com', name: 'Ada Admin', groups: ['admins', 'platform-admins'], sub: 'sub-admin-demo' }
    window.localStorage.setItem('voc-auth', JSON.stringify({ state: { user, accessToken: null, idToken: null, isAuthenticated: true }, version: 1 }))
  })
}

/** The mock workspace `slug` as the platform list answers it (`{}` when it lists none). */
async function platformRow(slug: string): Promise<Record<string, unknown>> {
  const { status, body } = await apiCall('admin', 'GET', '/platform/workspaces')
  expect(status).toBe(200)
  const rows = isRecord(body) && Array.isArray(body['workspaces']) ? body['workspaces'] : []
  const row: unknown = rows.find((candidate: unknown) => isRecord(candidate) && candidate['slug'] === slug)
  return isRecord(row) ? row : {}
}

/** The id of the mock workspace `slug`, read from the platform list (so the spec never copies an id). */
async function workspaceId(slug: string): Promise<string> {
  const id = (await platformRow(slug))['id']
  return typeof id === 'string' ? id : ''
}

/** Every `method` request to the API path `pathname` the page sends from now on. */
function apiRequestsTo(page: Page, method: string, pathname: string): Request[] {
  const seen: Request[] = []
  const origin = new URL(apiUrl()).origin
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin === origin && url.pathname === pathname && request.method() === method) seen.push(request)
  })
  return seen
}

/** Every `method` request to the S3 import route `route` from now on, at the API's origin or through the dev
 *  server's `/api` proxy (a dev server started without VITE_API_ENDPOINT). */
function s3ImportRequests(page: Page, method: string, route: string): Request[] {
  const seen: Request[] = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if ((pathname === route || pathname === `/api${route}`) && request.method() === method) seen.push(request)
  })
  return seen
}

/** The header's workspace menu button for `name` with the Admin role (either label: with or without others to switch to). */
const workspaceMenuButton = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^Workspace: ${escapeRegExp(name)}, Admin\\.`) })

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
      // Exact: the console's deployment brand below has a "Brand Name".
      await page.getByLabel('Name', { exact: true }).fill(TEXT.field)
      await page.getByLabel('Address (slug)').fill('acme-field')
      await page.getByRole('button', { name: 'Create workspace' }).click()
      await expect(page.getByRole('status')).toContainText(`Created ${TEXT.field}. You are its admin.`)
      await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: `Enter ${TEXT.field}` }).first().click()])
      await page.waitForURL(/\/workspace\/acme-field\/$/)
      await expect(page.getByRole('button', { name: `Workspace: ${TEXT.field}, Admin. Switch workspace` })).toBeVisible()
    })
  })

  test('an admin adds a member, changes the role, and is refused demoting the last admin', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-admin-02-members', async () => {
      await page.goto(site('/workspace/acme/members'), { waitUntil: 'domcontentloaded' })
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
      await page.goto(site('/workspace/juniper/members'), { waitUntil: 'domcontentloaded' })
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
      const sent = workspaceIdsSent(page, '/workspace/juniper/')
      await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: `Enter ${TEXT.juniper}` }).click()])
      await page.waitForURL(/\/workspace\/juniper\/$/)
      await expect(page.getByRole('button', { name: `Workspace: ${TEXT.juniper}, Admin. Switch workspace` })).toBeVisible()
      // Every call the page has sent names juniper (one value), polled until the page's calls have gone out.
      await expect.poll(sent).toStrictEqual([juniperId])
    })
  })

  test("a workspace admin saves the workspace's brand and turns a plugin on and off for it", async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-admin-05-workspace-settings', async () => {
      const acmeId = await workspaceId('acme')
      await page.goto(site('/workspace/acme/dashboard'), { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: new RegExp(`^Workspace: ${TEXT.acme}, Admin\\.`) }).click()
      await page.getByRole('menuitem', { name: 'Workspace settings' }).click()
      await expect(page.getByRole('heading', { name: 'Workspace settings', level: 1 })).toBeVisible()

      const brand = page.getByRole('region', { name: 'Brand' })
      await brand.getByLabel('Brand Name').fill(TEXT.acmeBrand)
      await brand.getByRole('button', { name: 'Save Changes' }).click()
      // The card's own "Saved" (components/SavedStatus, 7.54.00), until its next edit.
      await expect(brand.getByRole('status')).toHaveText('Saved')
      // Saved in acme, not in the deployment's brand.
      expect(await brandName(page, acmeId)).toBe(TEXT.acmeBrand)
      expect(await brandName(page, null)).not.toBe(TEXT.acmeBrand)

      const plugins = page.getByRole('region', { name: 'Plugins' })
      await expect(plugins.getByRole('list', { name: 'Plugins this deployment offers' })).toContainText('Web Scraper')
      await plugins.getByRole('button', { name: 'Enable Web Scraper for this workspace' }).click()
      await expect(plugins.getByRole('button', { name: 'Disable Web Scraper for this workspace' })).toBeEnabled()
      await expect(plugins.getByRole('list', { name: 'Plugins this deployment offers' })).toContainText(/Web Scraper\s*On/)
      await plugins.getByRole('button', { name: 'Disable Web Scraper for this workspace' }).click()
      await expect(plugins.getByRole('button', { name: 'Enable Web Scraper for this workspace' })).toBeEnabled()
    })
  })

  test("a platform admin edits the deployment's default brand from the console, inside a workspace", async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-admin-06-deployment-brand', async () => {
      const before = await storedBrand(page, null)
      try {
        await page.goto(site(CONSOLE), { waitUntil: 'domcontentloaded' })
        const card = page.getByRole('region', { name: 'Deployment default brand' })
        await expect(card.getByLabel('Brand Name')).toHaveValue(String(before['brand_name']))
        await card.getByLabel('Brand Name').fill(TEXT.deploymentBrand)
        const [save] = await Promise.all([
          page.waitForRequest((request) => request.method() === 'PUT' && new URL(request.url()).pathname === '/settings/brand'),
          card.getByRole('button', { name: 'Save Changes' }).click(),
        ])
        await expect(card.getByRole('status')).toHaveText('Saved')
        // The client's opt-out: no workspace on this call, though the page is inside acme.
        expect(save.headers()['x-workspace-id']).toBeUndefined()
        expect(await brandName(page, null)).toBe(TEXT.deploymentBrand)
      } finally {
        // The deployment's brand as it was, every field, for the specs after this one.
        await apiCall('admin', 'PUT', '/settings/brand', before)
      }
    })
  })

  test('a workspace admin renames the workspace from Workspace settings; its address stays', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-admin-07-rename', async () => {
      const acmeId = await workspaceId('acme')
      expect(acmeId).not.toBe('')
      try {
        await page.goto(site('/workspace/acme/workspace-settings'), { waitUntil: 'domcontentloaded' })
        const card = page.getByRole('region', { name: 'Workspace name' })
        await expect(card.getByText(TEXT.acme, { exact: true })).toBeVisible()
        await expect(card).toContainText('Address: /workspace/acme')
        const puts = apiRequestsTo(page, 'PUT', '/me/workspaces/current')

        await card.getByRole('button', { name: 'Rename' }).click()
        const dialog = dialogNamed(page, 'Rename the workspace')
        await expect(dialog).toContainText('Its address, /workspace/acme, stays the same')
        const field = dialog.getByLabel('Name', { exact: true })
        const save = dialog.getByRole('button', { name: 'Save', exact: true })
        await expect(field).toHaveValue(TEXT.acme)
        // Blank once trimmed: nothing to save.
        await field.fill('   ')
        await expect(save).toBeDisabled()
        // Over 80 characters: the field takes the first 80 only (its maxlength), so a longer name is never sent.
        await field.fill('x'.repeat(NAME_MAX + 1))
        await expect(field).toHaveValue('x'.repeat(NAME_MAX))
        // A control character (a tab): refused in the dialog, which stays open.
        await field.fill(`${TEXT.acme}\tTrail`)
        await save.click()
        await expect(dialog.getByRole('alert')).toHaveText('The name cannot contain control characters, such as tabs or line breaks.')
        expect(puts, 'no PUT for a name the dialog refuses').toHaveLength(0)

        await field.fill(`  ${TEXT.renamed}  `)
        const [put] = await Promise.all([
          page.waitForRequest((request) => request.method() === 'PUT' && new URL(request.url()).pathname === '/me/workspaces/current'),
          save.click(),
        ])
        expect(put.headers()['x-workspace-id']).toBe(acmeId)
        expect(put.postDataJSON()).toStrictEqual({ name: TEXT.renamed })
        await expect(card.getByRole('status')).toHaveText(`The workspace is now called ${TEXT.renamed}.`)
        await expect(dialogNamed(page, 'Rename the workspace')).toHaveCount(0)
        await expect(card.getByText(TEXT.renamed, { exact: true })).toBeVisible()
        await expect(workspaceMenuButton(page, TEXT.renamed)).toBeVisible()
        // The slug, so the address, is unchanged: on the card, in the page's URL and on the server.
        await expect(card).toContainText('Address: /workspace/acme')
        expect(new URL(page.url()).pathname).toBe('/workspace/acme/workspace-settings')
        expect(puts).toHaveLength(1)
        expect(await platformRow('acme')).toMatchObject({ id: acmeId, name: TEXT.renamed, slug: 'acme' })
      } finally {
        // acme's name as it was, for the steps after this one (the switch's next call starts afresh anyway).
        await apiCall('admin', 'PUT', '/me/workspaces/current', { name: TEXT.acme }, { workspace: acmeId })
      }
    })
  })

  test('a workspace admin deletes a workspace from Workspace settings: confirmed, gone, not found', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-admin-08-delete', async () => {
      // Its own workspace (the caller its admin), so the steps above keep theirs.
      expect((await apiCall('admin', 'POST', '/platform/workspaces', { name: TEXT.popup, slug: POPUP_SLUG })).status).toBe(201)
      const popupId = await workspaceId(POPUP_SLUG)
      expect(popupId).not.toBe('')
      await page.goto(site(`/workspace/${POPUP_SLUG}/workspace-settings`), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: 'Workspace settings', level: 1 })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Workspace name' })).toBeVisible()
      const card = page.getByRole('region', { name: 'Delete workspace' })
      await expect(card, 'no delete card: start the dev server with VITE_ENABLE_WORKSPACE_DELETE=true (scripts/dev-with-mock.mjs does)').toBeVisible()
      await expect(card).toContainText('Deleting this workspace is permanent and cannot be undone.')

      await card.getByRole('button', { name: 'Delete workspace…' }).click()
      const dialog = dialogNamed(page, `Delete ${TEXT.popup}?`)
      const slug = dialog.getByLabel(`Type the workspace's slug, ${POPUP_SLUG}, to confirm`)
      const reason = dialog.getByLabel('Reason for deleting')
      const understood = dialog.getByLabel('I understand that deleting this workspace cannot be undone.')
      const confirm = dialog.getByRole('button', { name: 'Delete workspace', exact: true })
      await expect(confirm).toBeDisabled()
      // Reason and "I understand" with the slug not typed exactly (one letter short, then in capitals): disabled.
      await reason.fill(TEXT.deleteReason)
      await understood.check()
      await slug.fill(POPUP_SLUG.slice(0, -1))
      await expect(confirm).toBeDisabled()
      await slug.fill(POPUP_SLUG.toUpperCase())
      await expect(confirm).toBeDisabled()
      await slug.fill(POPUP_SLUG)
      await expect(confirm).toBeEnabled()
      // Each of the other two taken away disables it again.
      await reason.fill('')
      await expect(confirm).toBeDisabled()
      await reason.fill(TEXT.deleteReason)
      await understood.uncheck()
      await expect(confirm).toBeDisabled()
      await understood.check()
      await expect(confirm).toBeEnabled()

      const [request] = await Promise.all([
        page.waitForRequest((sent) => sent.method() === 'POST' && new URL(sent.url()).pathname === '/me/workspaces/current/delete'),
        confirm.click(),
      ])
      expect(request.headers()['x-workspace-id']).toBe(popupId)
      expect(request.postDataJSON()).toStrictEqual({ confirm_slug: POPUP_SLUG, legal_basis: TEXT.deleteReason })
      const done = dialogNamed(page, `${TEXT.popup} is being deleted`)
      await expect(done.getByRole('status')).toContainText('It is gone for every member now: nobody can open it any more.')
      await Promise.all([page.waitForEvent('load'), done.getByRole('button', { name: 'Go to my workspaces' }).click()])
      expect(new URL(page.url()).pathname).toBe('/')
      // The list still names it until the job removes its rows; the page offers the others only.
      await expect(page.getByRole('heading', { name: 'Choose a workspace' })).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Your workspaces' }).getByRole('link', { name: new RegExp(escapeRegExp(TEXT.popup)) })).toHaveCount(0)

      expect((await apiCall('admin', 'GET', '/me/workspaces/current', undefined, { workspace: popupId, expect: [404] })).status).toBe(404)
      expect((await platformRow(POPUP_SLUG))['status']).toBe('deleting')
      await page.goto(site(`/workspace/${POPUP_SLUG}/`), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: 'Workspace not found' })).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
    })
  })

  test("a workspace admin's S3 import files stay in the workspace; another workspace and the deployment keep theirs", async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-admin-09-s3-import', async () => {
      // Another workspace of the caller's (its admin), so the steps above keep theirs.
      expect((await apiCall('admin', 'POST', '/platform/workspaces', { name: TEXT.depot, slug: DEPOT_SLUG })).status).toBe(201)
      const acmeId = await workspaceId('acme')
      expect(acmeId).not.toBe('')
      const uploads = s3ImportRequests(page, 'POST', '/s3-import/upload-url')

      // In acme: its own place, empty at first, then the uploaded file.
      await page.goto(site(`/workspace/acme${S3_IMPORT_CARD}`), { waitUntil: 'domcontentloaded' })
      await expect(page.getByText(TEXT.noImportFiles)).toBeVisible()
      await page.getByLabel('Drop files here or click to upload').setInputFiles(
        { name: IMPORT_FILE, mimeType: 'text/csv', buffer: Buffer.from('text\nThe boots held up on the ridge\n') })
      await expect(page.getByText(`Uploaded ${IMPORT_FILE}`)).toBeVisible()
      await expect(page.getByText(IMPORT_FILE, { exact: true })).toBeVisible()
      expect(uploads.map((request) => request.headers()['x-workspace-id'])).toStrictEqual([acmeId])
      // The deployment's seeded files are not acme's.
      await expect(page.getByText(DEPLOYMENT_IMPORT_FILE, { exact: true })).toHaveCount(0)

      // In the other workspace: none of acme's.
      await page.goto(site(`/workspace/${DEPOT_SLUG}${S3_IMPORT_CARD}`), { waitUntil: 'domcontentloaded' })
      await expect(page.getByText(TEXT.noImportFiles)).toBeVisible()
      await expect(page.getByText(IMPORT_FILE, { exact: true })).toHaveCount(0)

      // The platform admin's deployment view, inside acme: the deployment's own files, not acme's, no header.
      const deploymentReads = s3ImportRequests(page, 'GET', '/s3-import/files')
      await page.goto(site(`/workspace/acme${S3_IMPORT_CARD}?scope=deployment`), { waitUntil: 'domcontentloaded' })
      await expect(page.getByText(DEPLOYMENT_IMPORT_FILE, { exact: true })).toBeVisible()
      await expect(page.getByText(IMPORT_FILE, { exact: true })).toHaveCount(0)
      expect(deploymentReads.length).toBeGreaterThan(0)
      expect(deploymentReads.every((request) => request.headers()['x-workspace-id'] === undefined)).toBe(true)
    })
  })
})

/** The stored brand, of the workspace `id` (its X-Workspace-Id) or of the deployment (`null`: no header). */
async function storedBrand(page: Page, id: string | null): Promise<Record<string, unknown>> {
  const response = await page.request.get(`${apiUrl()}/settings/brand`, { headers: id === null ? {} : { 'X-Workspace-Id': id } })
  const body: unknown = await response.json()
  return isRecord(body) ? body : {}
}

/** The stored brand's name (see {@link storedBrand}). */
async function brandName(page: Page, id: string | null): Promise<string> {
  const name = (await storedBrand(page, id))['brand_name']
  return typeof name === 'string' ? name : ''
}
