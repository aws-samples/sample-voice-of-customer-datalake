/**
 * 5.x workflow revision History (components/WorkflowEditor/WorkflowHistory.tsx) on the
 * library page `/agents/workflows/:id` (pages/Agents/WorkflowPage.tsx).
 *
 * 1. Built-in `wf_default` (read-only, both roles): History opens "Revision history",
 *    lists its revisions with the current one marked, shows the current revision
 *    (`GET /workflows/wf_default/revisions/{n}` 200, "This is the current revision."),
 *    offers no Save inside, and closes back to the unchanged editor. Nothing is
 *    restored or saved; the built-in cannot be saved anyway.
 * 2. Admin only: an e2e workflow (`POST /workflows` with the built-in's definition,
 *    named `e2e-<run id>-history-wf`, ledger-recorded) gets a second revision by an
 *    edit of its description saved in the editor (`PUT /workflows/{id}` → revision 2).
 *    History lists both, newest first, revision 2 current; opening revision 1
 *    (`GET …/revisions/1` 200) shows it read-only — what restoring it would change,
 *    no Save, no editable field — and is never restored. Closing returns to the
 *    current revision: no unsaved changes, Save disabled, the saved description kept.
 *    The spec archives the workflow itself (`DELETE /workflows/{id}`) and proves it
 *    left the library; cleanup would archive it from the ledger otherwise.
 *
 * Production and the dev mock run the same steps (the mock has no e2e-user: role
 * steps run as the admin).
 *
 * Mock run (from voc-datalake/frontend/e2e, mock + vite on your own ports):
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/workflow-history.spec.ts
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { BUILTIN_WORKFLOW_ID, RUN_PREFIX } from '../lib/env'
import { isRecord } from '../lib/guards'
import { recordCreated } from '../lib/ledger'
import { assertStep, escapeRegExp, isApi, roleOf, settle, site } from '../lib/fixtures'

const WORKFLOW_NAME = `${RUN_PREFIX}history-wf`
const SECOND_DESCRIPTION = `${RUN_PREFIX}history second revision`

/** agents.json `editor.*` strings. */
const TEXT = {
  history: 'History',
  dialog: 'Revision history',
  list: 'Revisions',
  current: 'Current',
  isCurrent: 'This is the current revision.',
  changes: 'Restoring it would change',
  restore: 'Restore into editor',
  close: 'Close',
  save: 'Save',
  unsaved: 'Unsaved changes',
  panel: 'Step settings',
  description: 'Description',
} as const

const objectOf = (body: unknown, key: string): Record<string, unknown> =>
  isRecord(body) && isRecord(body[key]) ? body[key] : {}

/** Revision `n`'s row button in the History list (WorkflowHistory's `data-revision`). */
const revisionRow = (dialog: Locator, n: number): Locator =>
  dialog.getByRole('list', { name: TEXT.list }).locator(`[data-revision="${n}"]`).getByRole('button')

const saveButton = (page: Page): Locator => page.getByRole('button', { name: TEXT.save, exact: true })

async function openWorkflowPage(page: Page, id: string): Promise<void> {
  await page.goto(site(`/agents/workflows/${encodeURIComponent(id)}`), { waitUntil: 'domcontentloaded' })
  await settle(page, 600)
  await expect(page.locator('.react-flow__pane')).toBeVisible()
}

/** History → the "Revision history" dialog, with the current revision's GET answered. */
async function openHistory(page: Page, id: string, current: number): Promise<{ dialog: Locator; status: number }> {
  const fetched = page.waitForResponse((r) => isApi(r, 'GET', new RegExp(`/workflows/${escapeRegExp(id)}/revisions/${current}$`)))
  await page.getByRole('button', { name: TEXT.history, exact: true }).click()
  const dialog = dialogNamed(page, TEXT.dialog)
  await expect(dialog).toBeVisible()
  return { dialog, status: (await fetched).status() }
}

/** The revision detail inside the dialog is read-only: no Save, no editable field. */
async function expectReadOnlyDetail(dialog: Locator): Promise<void> {
  await expect(dialog.getByRole('button', { name: TEXT.save, exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await expect(dialog.getByRole('combobox')).toHaveCount(0)
}

async function closeHistory(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: TEXT.close, exact: true }).click()
  await expect(dialogNamed(page, TEXT.dialog)).toHaveCount(0)
  await expect(page.getByText(TEXT.unsaved, { exact: true })).toHaveCount(0)
}

/** A workflow's stored current revision number (GET /workflows/{id}; -1 when the answer has none). */
async function storedRevision(id: string): Promise<number> {
  const workflow = objectOf((await apiCall('admin', 'GET', `/workflows/${encodeURIComponent(id)}`)).body, 'workflow')
  return typeof workflow['revision'] === 'number' ? workflow['revision'] : -1
}

/** The workflow's own Description field in the side panel (nothing selected). */
const descriptionField = (page: Page): Locator =>
  page.getByRole('complementary', { name: TEXT.panel }).getByLabel(TEXT.description, { exact: true })

/** `POST /workflows` with the built-in's definition under the e2e name; recorded the moment its id is known. */
async function createE2eWorkflow(): Promise<string> {
  const builtin = objectOf((await apiCall('admin', 'GET', `/workflows/${BUILTIN_WORKFLOW_ID}`)).body, 'workflow')
  const definition = isRecord(builtin['definition']) ? builtin['definition'] : {}
  const created = await apiCall('admin', 'POST', '/workflows', {
    definition: { ...definition, name: WORKFLOW_NAME, description: 'Created by the e2e suite; archived at the end of the spec.' },
  })
  const id = stringField(objectOf(created.body, 'workflow'), 'workflow_id')
  if (created.status >= 300 || id === undefined) throw new Error(`POST /workflows -> ${created.status}, no workflow id`)
  recordCreated('workflow', id, WORKFLOW_NAME)
  return id
}

/** Edits the workflow's description in the side panel (nothing selected) and saves; returns the PUT status. */
async function saveSecondRevision(page: Page, id: string): Promise<number> {
  await descriptionField(page).fill(SECOND_DESCRIPTION)
  await expect(page.getByText(TEXT.unsaved, { exact: true })).toBeVisible()
  const saved = page.waitForResponse((r) => isApi(r, 'PUT', new RegExp(`/workflows/${escapeRegExp(id)}$`)))
  await saveButton(page).click()
  const status = (await saved).status()
  await expect(page.getByText(TEXT.unsaved, { exact: true })).toHaveCount(0)
  return status
}

test.describe('workflow history', () => {
  test('the built-in workflow lists its revisions and shows the current one read-only', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const current = await storedRevision(BUILTIN_WORKFLOW_ID)
    await assertStep(page, role, 'workflow-history-builtin', async () => {
      await openWorkflowPage(page, BUILTIN_WORKFLOW_ID)
      const { dialog, status } = await openHistory(page, BUILTIN_WORKFLOW_ID, current)
      expect(status, `GET /workflows/${BUILTIN_WORKFLOW_ID}/revisions/${current}`).toBe(200)
      const row = revisionRow(dialog, current)
      await expect(row).toHaveAttribute('aria-current', 'true')
      await expect(row).toContainText(TEXT.current)
      await expect(dialog.getByText(TEXT.isCurrent, { exact: true })).toBeVisible()
      await expectReadOnlyDetail(dialog)
      // Restore is an admin's, and only loads a draft; never clicked here.
      await expect(dialog.getByRole('button', { name: TEXT.restore })).toHaveCount(role === 'admin' ? 1 : 0)
      await closeHistory(page, dialog)
      await expect(saveButton(page)).toHaveCount(role === 'admin' ? 1 : 0)
      if (role === 'admin') await expect(saveButton(page)).toBeDisabled()
    })
    expect(await storedRevision(BUILTIN_WORKFLOW_ID), 'the built-in was not saved').toBe(current)
  })

  test.describe('an e2e workflow with two revisions', () => {
    let workflowId = ''

    test.beforeEach(({}, testInfo) => {
      test.skip(roleOf(testInfo) !== 'admin', 'admin-only: e2e-user only reads workflows')
    })

    test.afterAll(async () => {
      if (workflowId === '') return
      const archived = await apiCall('admin', 'DELETE', `/workflows/${encodeURIComponent(workflowId)}`)
      expect(archived.status, `DELETE /workflows/${workflowId}`).toBe(200)
      const listed = listOf((await apiCall('admin', 'GET', '/workflows')).body, 'items')
      expect(listed.some((w) => w['workflow_id'] === workflowId), 'archived workflow left the library').toBe(false)
    })

    test('History lists both revisions and opens the older one read-only; closing returns to the current', async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      workflowId = await createE2eWorkflow()
      await assertStep(page, role, 'workflow-history-save', async () => {
        await openWorkflowPage(page, workflowId)
        expect(await saveSecondRevision(page, workflowId), `PUT /workflows/${workflowId}`).toBe(200)
      })
      expect(await storedRevision(workflowId), 'the save made revision 2').toBe(2)

      await assertStep(page, role, 'workflow-history-open-old', async () => {
        const { dialog } = await openHistory(page, workflowId, 2)
        await expect(revisionRow(dialog, 2)).toContainText(TEXT.current)
        await expect(revisionRow(dialog, 1)).toBeVisible()
        await expect(dialog.getByRole('list', { name: TEXT.list }).getByRole('listitem')).toHaveCount(2)
        const older = page.waitForResponse((r) => isApi(r, 'GET', new RegExp(`/workflows/${escapeRegExp(workflowId)}/revisions/1$`)))
        await revisionRow(dialog, 1).click()
        expect((await older).status(), `GET /workflows/${workflowId}/revisions/1`).toBe(200)
        await expect(revisionRow(dialog, 1)).toHaveAttribute('aria-current', 'true')
        await expect(dialog.getByRole('region', { name: TEXT.changes })).toBeVisible()
        await expect(dialog.getByText(TEXT.isCurrent, { exact: true })).toHaveCount(0)
        await expectReadOnlyDetail(dialog)
        await closeHistory(page, dialog)
        // Back on the current revision, untouched: nothing to save, the saved description in the panel.
        await expect(saveButton(page)).toBeDisabled()
        await expect(descriptionField(page)).toHaveValue(SECOND_DESCRIPTION)
      })
      expect(await storedRevision(workflowId), 'browsing history saved nothing').toBe(2)
    })
  })
})
