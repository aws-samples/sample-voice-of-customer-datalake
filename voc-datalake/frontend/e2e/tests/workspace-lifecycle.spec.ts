/**
 * A workspace's whole life on a deployment (7.40.00; docs/multi-workspace.md), driven by the admin test user as a
 * platform admin, through the API, plus one look at Workspace settings:
 *
 * 1. `POST /platform/workspaces` creates `e2e-<run id>-workspace` at the slug `e2e-<run id>` (ledger-recorded at
 *    once); `GET /me/workspaces/current` with its `X-Workspace-Id` enters it as admin; `PUT /me/workspaces/current`
 *    renames it, and both the caller's `GET /me/workspaces` and `GET /platform/workspaces` read the new name with
 *    the slug unchanged.
 * 2. The viewer test user, added as a viewer (`POST /me/workspaces/current/members`, the email of their own id
 *    token, so their own account), lists it in their `GET /me/workspaces`, enters it as a viewer, and is refused
 *    its rename (403, declared). They are removed again at once (see "Run it alone" below).
 * 3. Plugin web_reviews: Run now before the workspace enabled it is the declared 409 "Enable this plugin for the
 *    workspace first" (never a 500); enabled (`PUT /me/workspaces/current/plugins/web_reviews`), one review page is
 *    saved in the workspace (https://example.com/, 1 page, at most 1 review, Manual only; ledger-recorded) and run
 *    (`POST /sources/web_reviews/run`): never a 500 (before the 7.40.00 IAM fix: "Failed to open the workspace"),
 *    a 200/202, or a 409 declared beforehand and accepted only with its reason (an annotation).
 * 4. As the admin, `/w/<slug>/workspace-settings` shows the "Workspace name" card with the new name and its address,
 *    and the "Delete workspace" card exactly when the site's `/config.json` has `features.workspaceDelete`.
 * 5. With `features.workspaceDelete`: a wrong slug is refused (400, declared), then the delete with the slug and the
 *    reason "e2e cleanup" answers 202 (`waiting`, `fence`); `GET /me/workspaces/current` turns into the declared
 *    404 and `GET /platform/workspaces` lists it as `deleting`. Without it: the plugin is turned off and the
 *    workspace is left to the cleanup, which deletes its review page, removes its other members and turns its
 *    plugins off, and reports the workspace itself as kept (there is no other way to remove one).
 *
 * Skips: on the dev mock (its side is workspace-admin.spec.ts); in the user project (it drives both roles from the
 * admin project); unless `E2E_WORKSPACE_LIFECYCLE=1`; unless the admin test user is a platform admin
 * (`GET /platform/workspaces` answers 200; the `platform-admins` Cognito group); and, on a deployment without
 * `features.workspaceDelete`, unless `E2E_WORKSPACE_KEEP=1` too, because such a workspace can never be removed.
 *
 * Run it alone, opted in: the creator stays the workspace's admin member until the delete job removes its rows (the
 * fence is ~21 minutes; without the delete flag, for good), and `GET /me/workspaces` lists it meanwhile, so the gate
 * (src/workspace/gateDecision.ts) sends the admin test user's every page outside `/w/` into it (one workspace) or
 * to the picker (several): another spec running beside it, or a run started before the workspace is gone from
 * `GET /platform/workspaces`, would land there. Hence not in any shard group (unit/shard-groups.spec.ts).
 *
 *   E2E_WORKSPACE_LIFECYCLE=1 npx playwright test -c playwright.config.ts --project=admin tests/workspace-lifecycle.spec.ts
 */
import { expect } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { MOCK, RUN_ID, RUN_PREFIX, type Role } from '../lib/env'
import { assertStep, escapeRegExp, roleOf, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { recordCreated } from '../lib/ledger'
import { optIn } from '../lib/optIn'
import { cognitoEmailFor, cognitoSubFor } from '../lib/session'
import {
  E2E_DELETE_REASON, PLUGIN_NOT_ENABLED, WEB_REVIEWS, WORKSPACE_FAULT, answeredWorkspace, errorText, listedWorkspaces,
  platformWorkspace, slugFor, workspaceDeleteAvailable, workspacePlugins, type WorkspaceRow,
} from '../lib/workspaces'

/** The opt-in switch (lib/optIn.ts), and the second one a deployment without the delete flag needs. */
const OPT_IN = 'E2E_WORKSPACE_LIFECYCLE'
const KEEP = 'E2E_WORKSPACE_KEEP'

const NAME = {
  created: `${RUN_PREFIX}workspace`,
  renamed: `${RUN_PREFIX}workspace renamed`,
  viewerRename: `${RUN_PREFIX}workspace by the viewer`,
  page: `${RUN_PREFIX}review-page`,
} as const

/** The review page (plugins/web_reviews/manifest.json): a harmless public page, read once, never on a schedule. */
const REVIEW_URL = 'https://example.com/'
const REVIEW_PAGE = { app_name: NAME.page, url: REVIEW_URL, max_pages: '1', max_reviews: '1', frequency_minutes: '0' } as const

/**
 * Read-backs that another warm API container may answer from its membership cache (30 s, shared/workspace.py) or
 * that a write reaches a moment later (the members' rows a rename updates): polled, never assumed at once.
 */
const POLL = { timeout: 60_000, intervals: [1_000, 2_000, 5_000] }

/** The run-alone note every skip of the opt-in names. */
const ALONE = 'its workspace stays listed for the admin test user until the delete job removes it, so the gate sends the admin\'s pages outside /w/ into it: run it alone'

/** `role`'s own workspaces (`GET /me/workspaces`). */
async function mine(role: Role): Promise<WorkspaceRow[]> {
  const res = await apiCall(role, 'GET', '/me/workspaces')
  expect(res.status).toBe(200)
  return listedWorkspaces(res.body)
}

/** The object under `key` of an answer (`{member: {...}}`, `{plugin: {...}}`, `{app: {...}}`, `{delete: {...}}`), or `{}`. */
function entityOf(body: unknown, key: string): Record<string, unknown> {
  const value = isRecord(body) ? body[key] : undefined
  return isRecord(value) ? value : {}
}

/** The hint a refused or failed call's assertion carries: its status and error text, and what a 500 here means. */
const RUN_FAULT_HINT = `a 500 "${WORKSPACE_FAULT}" is the IAM regression fixed in 7.40.00`

test.describe('workspace lifecycle (deployment): create, rename, members, plugin run, delete', () => {
  test.skip(MOCK, 'deployment only: the dev mock\'s side is workspace-admin.spec.ts')
  test.skip(!optIn(OPT_IN), `opt-in (${OPT_IN}=1): ${ALONE}`)
  test.describe.configure({ mode: 'serial' })

  const run = { id: '', slug: '', deleteOn: false, pluginOn: false }

  test.beforeAll(async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'drives both roles from the admin project')
    const probe = await apiCall('admin', 'GET', '/platform/workspaces?limit=1', undefined, { expect: [403] })
    test.skip(probe.status !== 200,
      `the admin test user is not a platform admin (GET /platform/workspaces answered ${String(probe.status)}): add it to the platform-admins group`)
    run.deleteOn = await workspaceDeleteAvailable()
    test.skip(!run.deleteOn && !optIn(KEEP),
      `this deployment cannot delete a workspace (no features.workspaceDelete in /config.json), so the one this spec creates would stay for good, the admin test user its admin: ${KEEP}=1 runs it anyway`)
    run.slug = slugFor(RUN_ID)
  })

  test('a platform admin creates the run\'s workspace, enters it and renames it; the slug stays', async () => {
    const created = await apiCall('admin', 'POST', '/platform/workspaces', { name: NAME.created, slug: run.slug })
    const workspace = answeredWorkspace(created.body)
    // In the ledger the moment its id is known, so the cleanup retires it whatever fails next.
    if (workspace !== null) recordCreated('workspace', workspace.id, NAME.created)
    expect(created.status, errorText(created.body)).toBe(201)
    expect(workspace).toMatchObject({ name: NAME.created, slug: run.slug, role: 'admin' })
    run.id = workspace?.id ?? ''

    const entered = await apiCall('admin', 'GET', '/me/workspaces/current', undefined, { workspace: run.id })
    expect(entered.status, errorText(entered.body)).toBe(200)
    expect(answeredWorkspace(entered.body)).toMatchObject({ id: run.id, name: NAME.created, slug: run.slug, role: 'admin' })

    const renamed = await apiCall('admin', 'PUT', '/me/workspaces/current', { name: NAME.renamed }, { workspace: run.id })
    expect(renamed.status, errorText(renamed.body)).toBe(200)
    expect(answeredWorkspace(renamed.body)).toMatchObject({ id: run.id, name: NAME.renamed, slug: run.slug })
    // Read back where the app reads it: the caller's list (the members' rows are renamed too) and the platform list.
    await expect.poll(() => mine('admin'), POLL)
      .toContainEqual(expect.objectContaining({ id: run.id, name: NAME.renamed, slug: run.slug, role: 'admin' }))
    await expect.poll(() => platformWorkspace(run.id), POLL).toMatchObject({ name: NAME.renamed, slug: run.slug, status: 'active' })
  })

  test('the viewer, added as a viewer, lists and enters the workspace and is refused its rename', async () => {
    const email = cognitoEmailFor('user')
    test.skip(email === null, 'the viewer test user\'s id token has no email, which the members route adds a person by')
    const viewerSub = cognitoSubFor('user')
    const added = await apiCall('admin', 'POST', '/me/workspaces/current/members', { email, role: 'viewer' }, { workspace: run.id })
    try {
      expect(added.status, errorText(added.body)).toBe(201)
      // Their own account, never a new one.
      expect(entityOf(added.body, 'member')).toMatchObject({ sub: viewerSub, role: 'viewer', account: 'existing' })
      await expect.poll(() => mine('user'), POLL)
        .toContainEqual(expect.objectContaining({ id: run.id, name: NAME.renamed, slug: run.slug, role: 'viewer' }))
      const entered = await apiCall('user', 'GET', '/me/workspaces/current', undefined, { workspace: run.id })
      expect(entered.status, errorText(entered.body)).toBe(200)
      expect(answeredWorkspace(entered.body)).toMatchObject({ id: run.id, slug: run.slug, role: 'viewer' })

      const refused = await apiCall('user', 'PUT', '/me/workspaces/current', { name: NAME.viewerRename }, { workspace: run.id, expect: [403] })
      expect(refused.status, errorText(refused.body)).toBe(403)
      expect((await platformWorkspace(run.id))?.name).toBe(NAME.renamed)
    } finally {
      if (added.status === 201) {
        // Out again at once: listed, the workspace would send the viewer's pages outside /w/ into it too, and a
        // deleted one stays listed until its job removes its rows. Soft: a failure above stays the one reported.
        const removed = await apiCall('admin', 'DELETE', `/me/workspaces/current/members/${encodeURIComponent(viewerSub)}`, undefined, { workspace: run.id })
        expect.soft(removed.status, `remove the viewer: ${errorText(removed.body)}`).toBe(200)
        await expect.soft.poll(async () => (await mine('user')).some((row) => row.id === run.id), POLL).toBe(false)
      }
    }
  })

  test('web_reviews: on in a new workspace; turned off, Run now is a 409; back on, a review page runs (never a 500)', async ({}, testInfo) => {
    const offered = await apiCall('admin', 'GET', '/me/workspaces/current/plugins', undefined, { workspace: run.id })
    expect(offered.status, errorText(offered.body)).toBe(200)
    const plugin = workspacePlugins(offered.body).find((entry) => entry.id === WEB_REVIEWS)
    test.skip(plugin === undefined, `this deployment does not offer ${WEB_REVIEWS} to workspaces (GET /me/workspaces/current/plugins)`)
    // 7.40.00: every plugin the deployment offers starts on in a new workspace.
    expect(plugin?.enabled, 'a new workspace starts with every plugin on').toBe(true)
    run.pluginOn = true

    const off = await apiCall('admin', 'PUT', `/me/workspaces/current/plugins/${WEB_REVIEWS}`, { enabled: false }, { workspace: run.id })
    expect(off.status, errorText(off.body)).toBe(200)
    run.pluginOn = false
    const early = await apiCall('admin', 'POST', `/sources/${WEB_REVIEWS}/run`, {}, { workspace: run.id, expect: [409] })
    expect(early.status, `${errorText(early.body)} (${RUN_FAULT_HINT})`).not.toBe(500)
    expect(early.status, errorText(early.body)).toBe(409)
    expect(errorText(early.body)).toBe(PLUGIN_NOT_ENABLED)

    const on = await apiCall('admin', 'PUT', `/me/workspaces/current/plugins/${WEB_REVIEWS}`, { enabled: true }, { workspace: run.id })
    expect(on.status, errorText(on.body)).toBe(200)
    run.pluginOn = true
    expect(entityOf(on.body, 'plugin')).toMatchObject({ id: WEB_REVIEWS, enabled: true })

    const saved = await apiCall('admin', 'POST', `/integrations/${WEB_REVIEWS}/apps`, { app: REVIEW_PAGE, mode: 'create' }, { workspace: run.id })
    const app = entityOf(saved.body, 'app')
    const appId = stringField(app, 'id') ?? ''
    if (appId !== '') recordCreated('review-page', appId, NAME.page, undefined, run.id)
    expect(saved.status, errorText(saved.body)).toBe(200)
    expect(app).toMatchObject({ app_name: NAME.page, url: REVIEW_URL, max_pages: '1', frequency_minutes: '0' })
    // Saved in the workspace's own config: listed there, not in the deployment's.
    const listed = await apiCall('admin', 'GET', `/integrations/${WEB_REVIEWS}/apps`, undefined, { workspace: run.id })
    expect(listOf(listed.body, 'apps').map((row) => row['id'])).toContain(appId)
    const deployment = await apiCall('admin', 'GET', `/integrations/${WEB_REVIEWS}/apps`)
    expect(listOf(deployment.body, 'apps').map((row) => row['id'])).not.toContain(appId)

    // A 409 is declared up front; it is accepted only with its reason, which cannot be "not enabled" any more.
    const ran = await apiCall('admin', 'POST', `/sources/${WEB_REVIEWS}/run`, { app_id: appId }, { workspace: run.id, expect: [409] })
    expect(ran.status, `${errorText(ran.body)} (${RUN_FAULT_HINT})`).not.toBe(500)
    expect([200, 202, 409], `POST /sources/${WEB_REVIEWS}/run: ${errorText(ran.body)}`).toContain(ran.status)
    if (ran.status === 409) {
      const reason = errorText(ran.body)
      expect(reason, 'a 409 names its reason').not.toBe('')
      expect(reason).not.toBe(PLUGIN_NOT_ENABLED)
      testInfo.annotations.push({ type: 'run-refused', description: `POST /sources/${WEB_REVIEWS}/run: 409 ${reason}` })
    } else {
      expect(ran.body).toMatchObject({ success: true, source: WEB_REVIEWS })
      const execution = isRecord(ran.body) ? stringField(ran.body, 'execution_id') : undefined
      testInfo.annotations.push({ type: 'run', description: `POST /sources/${WEB_REVIEWS}/run: ${String(ran.status)} ${execution ?? ''}` })
    }
  })

  test('Workspace settings shows the name card, and the delete card exactly when the deployment offers it', async ({ page }, testInfo) => {
    await assertStep(page, roleOf(testInfo), 'workspace-lifecycle-04-settings', async (recorder) => {
      const card = page.getByRole('region', { name: 'Workspace name' })
      // The card reads GET /me/workspaces/current, which a warm container may answer with the old name for 30 s.
      await expect(async () => {
        await page.goto(site(`/w/${run.slug}/workspace-settings`), { waitUntil: 'domcontentloaded' })
        await expect(card.getByText(NAME.renamed, { exact: true })).toBeVisible({ timeout: 10_000 })
      }).toPass({ timeout: POLL.timeout })
      await expect(page.getByRole('heading', { name: 'Workspace settings', level: 1 })).toBeVisible()
      await expect(card).toContainText(`Address: /w/${run.slug}`)
      await expect(card.getByRole('button', { name: 'Rename' })).toBeVisible()
      await expect(page.getByRole('button', { name: new RegExp(`^Workspace: ${escapeRegExp(NAME.renamed)}, Admin\\.`) })).toBeVisible()
      const deleteCard = page.getByRole('region', { name: 'Delete workspace' })
      if (run.deleteOn) await expect(deleteCard.getByRole('button', { name: 'Delete workspace…' })).toBeVisible()
      else await expect(deleteCard).toHaveCount(0)
      recorder.note(`name card: ${NAME.renamed} at /w/${run.slug}; delete card ${run.deleteOn ? 'shown' : 'absent (flag off)'}`)
    })
  })

  test('the workspace is deleted with its slug: a 404 for its members at once, listed as deleting', async ({}, testInfo) => {
    test.skip(!run.deleteOn, 'this deployment has no features.workspaceDelete: the next step turns the plugin off instead')
    const wrong = await apiCall('admin', 'POST', '/me/workspaces/current/delete', { confirm_slug: `${run.slug}-x`, legal_basis: E2E_DELETE_REASON }, { workspace: run.id, expect: [400] })
    expect(wrong.status, errorText(wrong.body)).toBe(400)

    const deleted = await apiCall('admin', 'POST', '/me/workspaces/current/delete', { confirm_slug: run.slug, legal_basis: E2E_DELETE_REASON }, { workspace: run.id })
    expect(deleted.status, errorText(deleted.body)).toBe(202)
    const job = entityOf(deleted.body, 'delete')
    expect(job).toMatchObject({ workspace_id: run.id, status: 'waiting', phase: 'fence' })
    expect(typeof job['fence_at'], 'the answer says when the data begins to go').toBe('string')

    // Every route of it answers the one 404 (a warm container's membership cache may still answer it for 30 s).
    await expect.poll(async () => (await apiCall('admin', 'GET', '/me/workspaces/current', undefined, { workspace: run.id, expect: [404] })).status, POLL).toBe(404)
    await expect.poll(async () => (await platformWorkspace(run.id))?.status, POLL).toBe('deleting')
    testInfo.annotations.push({
      type: 'workspace-delete',
      description: `${run.slug} deleting; its data goes from ${String(job['fence_at'])}. GET /me/workspaces lists it for the admin until then: start no other run before GET /platform/workspaces no longer does`,
    })
  })

  test('without the delete flag the plugin is turned off and the workspace is left to the cleanup', async ({}, testInfo) => {
    test.skip(run.deleteOn, 'the workspace was deleted in the step before')
    if (run.pluginOn) {
      const off = await apiCall('admin', 'PUT', `/me/workspaces/current/plugins/${WEB_REVIEWS}`, { enabled: false }, { workspace: run.id })
      expect(off.status, errorText(off.body)).toBe(200)
      expect(entityOf(off.body, 'plugin')).toMatchObject({ id: WEB_REVIEWS, enabled: false })
    }
    testInfo.annotations.push({
      type: 'finding',
      description: `${run.slug} cannot be deleted on this deployment (no features.workspaceDelete): it stays, with the admin test user its admin, after the cleanup`,
    })
  })
})
