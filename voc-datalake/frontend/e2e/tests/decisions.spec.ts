/**
 * Project Decisions tab (`/projects/{id}?tab=decisions`, docs/decisions-and-release-watch.md),
 * admin, on this run's PUBLIC e2e project (`ensureE2eProject`):
 *
 * - create `${RUN_PREFIX}decision` (New decision → form "Decision" → verdict Park → Save
 *   decision) → `POST /projects/{id}/decisions` 200, its card (an article named by the
 *   title) shows the verdict and rationale;
 * - edit it (Edit → new rationale + success metric → Save) → `PUT …/decisions/{doc}` 200,
 *   the card shows the edit, and `GET /projects/{id}` lists the document as
 *   `document_type: 'decision'`, revision ≥ 2, with the edited fields;
 * - the card and the save: a save shows on its card at once (5.35, decisionCache.ts), and
 *   again after a reload (it was stored); a second edit without a reload is its own test
 *   (before 5.35 the card kept its old values and that edit was refused as stale).
 * - delete it (Delete → "Delete this decision?" → Delete decision) →
 *   `DELETE /projects/{id}/documents/{doc}` 200, card gone, GET no longer lists it.
 *
 * Cleanup: a decision is not a ledger kind. It is a `DOC#{id}` row in the project's own
 * `PROJECT#{id}` partition (lambda/shared/decision_records.py `create_decision`), and the
 * project delete of the run's cleanup removes every row of that partition except the
 * META tombstone (lambda/api/projects.py `delete_project`, `_iter_partition_keys` sweep),
 * so the decision goes with the project whatever fails here.
 *
 * Production-safe: an e2e-named decision on an e2e project, verdict Park (no "Draft
 * PR/FAQ", no Bedrock), admin only; the user role skips (its writes are refused by the
 * safety model, and on the mock there is no second user). Mock and production run the
 * same steps.
 *
 * Local dev mock:
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:5484 E2E_API=http://127.0.0.1:3484 \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/decisions.spec.ts
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { RUN_PREFIX } from '../lib/env'
import { assertStep, isApi, jsonOf, roleOf, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { ensureE2eProject } from '../lib/projects'
import type { StepRecorder } from '../lib/recorder'

const PROJECT = `${RUN_PREFIX}decisions-project`
const TITLE = `${RUN_PREFIX}decision`
const RATIONALE = 'Recorded by the e2e suite: parked until the delivery fixes land.'
const EDITED_RATIONALE = 'Edited by the e2e suite: still parked, revisit next quarter.'
const SUCCESS_METRIC = 'Late-delivery complaints down 20% in 30 days'
const KILL_CRITERION = 'Stop if complaints do not move within 60 days'

const decisionsPath = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}?tab=decisions`
const card = (page: Page): Locator => page.getByRole('article', { name: TITLE, exact: true })
const form = (page: Page): Locator => page.getByRole('form', { name: 'Decision', exact: true })

/** The card after a reload, once it showed `expected` at once (a save updates the card without a reload). */
async function reloadedCard(page: Page, r: StepRecorder, expected: string): Promise<Locator> {
  await expect(card(page), 'the card shows the save before any reload').toContainText(expected)
  r.note('card current before a reload: yes')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await settle(page, 500)
  return card(page)
}

async function openDecisions(page: Page, projectId: string): Promise<void> {
  await page.goto(site(decisionsPath(projectId)), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
  await expect(page.getByRole('heading', { name: 'Decisions', exact: true })).toBeVisible()
}

/** The run's decision document as `GET /projects/{id}` lists it, if it does. */
async function storedDecision(projectId: string): Promise<Record<string, unknown> | undefined> {
  const res = await apiCall('admin', 'GET', `/projects/${encodeURIComponent(projectId)}`)
  expect(res.status, 'GET /projects/{id}').toBe(200)
  return listOf(res.body, 'documents').find((d) => d['document_type'] === 'decision' && d['title'] === TITLE)
}

/** This run's decision id: the one stored (create is idempotent per run: a retry reuses it). */
async function decisionIdOrSkip(projectId: string): Promise<string> {
  const id = stringField(await storedDecision(projectId), 'document_id')
  test.skip(id === undefined, `no decision ${TITLE} (the create step failed)`)
  return id ?? ''
}

test.describe.configure({ mode: 'serial' })

test.describe('project decisions: create, edit, delete', () => {
  let projectId = ''

  test.beforeEach(async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'decision writes are the admin\'s (the user role only reads)')
    projectId = await ensureE2eProject(PROJECT, 'public')
  })

  test('a new decision is saved and listed with its verdict', async ({ page }) => {
    await assertStep(page, 'admin', 'decisions-create', async (r) => {
      await openDecisions(page, projectId)
      if (await storedDecision(projectId) !== undefined) {
        r.note('the decision exists from an earlier attempt of this run: not created twice')
        await expect(card(page)).toBeVisible()
        return
      }
      await page.getByRole('button', { name: 'New decision', exact: true }).click()
      await form(page).getByLabel('Title', { exact: true }).fill(TITLE)
      await form(page).getByRole('radio', { name: 'Park', exact: true }).check()
      await form(page).getByLabel('Rationale', { exact: true }).fill(RATIONALE)
      const created = page.waitForResponse((res) => isApi(res, 'POST', /\/projects\/[^/]+\/decisions$/))
      await form(page).getByRole('button', { name: 'Save decision', exact: true }).click()
      const response = await created
      const body = await jsonOf(response)
      const id = stringField(isRecord(body['document']) ? body['document'] : undefined, 'document_id')
      r.note(`POST /projects/{id}/decisions -> ${response.status()} document ${id ?? '?'}`)
      expect(response.status()).toBe(200)
      expect(id, 'the created decision id').toBeDefined()
      await expect(form(page)).toBeHidden()
      const saved = await reloadedCard(page, r, RATIONALE)
      await expect(saved).toContainText(RATIONALE)
      await expect(saved).toContainText('Park')
    })
  })

  test('an edited decision shows the edit on its card and in the API', async ({ page }) => {
    const id = await decisionIdOrSkip(projectId)
    await assertStep(page, 'admin', 'decisions-edit', async (r) => {
      await openDecisions(page, projectId)
      await card(page).getByRole('button', { name: 'Edit', exact: true }).click()
      await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue(TITLE)
      await form(page).getByLabel('Rationale', { exact: true }).fill(EDITED_RATIONALE)
      await form(page).getByLabel('Success metric', { exact: true }).fill(SUCCESS_METRIC)
      const updated = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/decisions/${id}$`)))
      await form(page).getByRole('button', { name: 'Save decision', exact: true }).click()
      const response = await updated
      r.note(`PUT /projects/{id}/decisions/${id} -> ${response.status()}`)
      expect(response.status()).toBe(200)
      await expect(form(page)).toBeHidden()
      const edited = await reloadedCard(page, r, EDITED_RATIONALE)
      await expect(edited).toContainText(EDITED_RATIONALE)
      await expect(edited).toContainText(SUCCESS_METRIC)

      const stored = await storedDecision(projectId)
      const decision = isRecord(stored?.['decision']) ? stored['decision'] : {}
      r.note(`GET /projects/{id}: revision ${String(stored?.['revision'])}, verdict ${String(decision['verdict'])}`)
      // ≥ 2, not = 2: a retried attempt of this step edits once more.
      const revision = stored?.['revision']
      expect(typeof revision === 'number' ? revision : 0, 'revision after the edit').toBeGreaterThanOrEqual(2)
      expect(decision['verdict']).toBe('park')
      expect(decision['rationale']).toBe(EDITED_RATIONALE)
      expect(decision['success_metric']).toBe(SUCCESS_METRIC)
    })
  })

  test('a saved edit shows on its card without a reload', async ({ page }) => {
    const id = await decisionIdOrSkip(projectId)
    await assertStep(page, 'admin', 'decisions-edit-no-reload', async (r) => {
      await openDecisions(page, projectId)
      await card(page).getByRole('button', { name: 'Edit', exact: true }).click()
      await form(page).getByLabel('Kill criterion', { exact: true }).fill(KILL_CRITERION)
      const updated = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/decisions/${id}$`)))
      await form(page).getByRole('button', { name: 'Save decision', exact: true }).click()
      r.note(`PUT -> ${(await updated).status()}`)
      await expect(form(page)).toBeHidden()
      await expect(card(page)).toContainText(KILL_CRITERION)
    })
  })

  test('a deleted decision leaves the list and the API', async ({ page }) => {
    const id = await decisionIdOrSkip(projectId)
    await openDecisions(page, projectId)
    const deleteButton = card(page).getByRole('button', { name: 'Delete', exact: true })
    await assertStep(page, 'admin', 'decisions-delete', async (r) => {
      await deleteButton.click()
      const confirm = dialogNamed(page, 'Delete this decision?')
      await expect(confirm).toContainText(TITLE)
      const deleted = page.waitForResponse((res) => isApi(res, 'DELETE', new RegExp(`/documents/${id}$`)))
      await confirm.getByRole('button', { name: 'Delete decision', exact: true }).click()
      const response = await deleted
      r.note(`DELETE /projects/{id}/documents/${id} -> ${response.status()}`)
      expect(response.status()).toBe(200)
      await expect(confirm).toBeHidden()
      await expect(card(page)).toHaveCount(0)
      expect(await storedDecision(projectId), 'GET /projects/{id} still lists the decision').toBeUndefined()
    })
  })
})
