/**
 * Memory (R16, M34, E2E F3): on the caller's OWN personal memory only, both roles.
 *
 * - Add a run-named personal memory on the Personal tab ("Remember for me" →
 *   Remember) → `POST /memory` 2xx, the row shows Active; "+1" → confirm 200;
 *   Forget → "Forget this memory?" → Forget → forget 200, gone from the default
 *   list; Status filter Archived → Restore → restore 200 → Active again.
 * - The review queue failing: an injected 500 on `GET /memory/review` shows the
 *   page alert with Retry (not a silent empty page); a 403 (not a curator) is
 *   silent and, for a non-admin, hides the Needs review tab.
 *
 * The memory is recorded in the ledger as its owner's the moment its id is known,
 * so cleanup forgets it (memories are never deleted, only tombstoned) whatever
 * fails here. Production-safe: personal scope, e2e-named, cleaned up.
 *
 * Local dev mock (lists every status when no filter is set, so the "gone from the
 * default list" check is relaxed there):
 *   E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 \
 *     npx playwright test -c playwright.config.ts --project=admin --no-deps tests/memory.spec.ts
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test'
import { test } from '../lib/test'
import { stringField } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, RUN_ID, RUN_PREFIX, type Role } from '../lib/env'
import { isApi, jsonOf, roleOf, runStep, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { injectFailure, withoutInjected, type InjectionSpec } from '../lib/inject'
import { recordCreated } from '../lib/ledger'
import type { StepRecorder } from '../lib/recorder'

/**
 * The statement is stored with digit runs redacted (the memory scrubber treats a
 * long number as personal data: "e2e-p2-[redacted]-…" on production), so it
 * carries the run id spelled in letters; the ledger keeps the e2e name.
 */
const lettersOf = (text: string): string => text.replace(/\d/g, (d) => 'abcdefghij'.charAt(Number(d)))
const statementFor = (role: Role): string => `e2e memory check ${lettersOf(RUN_ID)} ${role}: prefers answers that end with one next step.`
const ledgerNameFor = (role: Role): string => `${RUN_PREFIX}memory-${role}`

const row = (page: Page, statement: string): Locator => page.getByRole('listitem').filter({ hasText: statement })

async function openPersonal(page: Page): Promise<void> {
  await page.goto(site('/memory'), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
  await page.getByRole('tab', { name: 'Personal' }).click()
  await expect(page.getByRole('tab', { name: 'Personal' })).toHaveAttribute('aria-selected', 'true')
}

/** Clicks `trigger`, returns the `POST /memory/{id}/<action>` answer. */
async function memoryAction(page: Page, id: string, action: 'confirm' | 'forget' | 'restore', trigger: () => Promise<void>): Promise<Response> {
  const answered = page.waitForResponse((res) => isApi(res, 'POST', new RegExp(`/memory/${id}/${action}$`)))
  await trigger()
  return answered
}

/** The memory id of a `POST /memory` answer (`{memory}` or the bare item). */
async function createdMemoryId(response: Response): Promise<string | undefined> {
  const body = await jsonOf(response)
  return stringField(isRecord(body['memory']) ? body['memory'] : body, 'memory_id', 'id')
}

async function step(page: Page, role: Role, name: string, action: (r: StepRecorder) => Promise<void>, injected: readonly InjectionSpec[] = []): Promise<void> {
  const { record, problems } = await runStep({ page, role, theme: 'dark', step: name, action })
  expect(withoutInjected(problems, ...injected), `${name}: ${record.screenshot ?? ''}`).toEqual([])
}

test.describe('memory: own personal memory', () => {
  test('add, +1, forget, restore', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const statement = statementFor(role)
    await step(page, role, 'memory-personal-lifecycle', async (r) => {
      await openPersonal(page)
      await page.getByLabel('Remember for me').fill(statement)
      const created = page.waitForResponse((res) => isApi(res, 'POST', /\/memory$/))
      await page.getByRole('button', { name: 'Remember', exact: true }).click()
      const response = await created
      const id = await createdMemoryId(response)
      r.note(`POST /memory -> ${response.status()} id=${id ?? '?'}`)
      expect(response.status()).toBeLessThan(300)
      if (id === undefined) throw new Error('POST /memory answered no memory id')
      recordCreated('memory', id, ledgerNameFor(role), role)
      await expect(page.getByRole('status').filter({ hasText: 'Remembered.' })).toBeVisible()
      await expect(row(page, statement)).toContainText('Active')

      const confirmed = await memoryAction(page, id, 'confirm', () => row(page, statement).getByRole('button', { name: '+1' }).click())
      r.note(`+1 -> ${confirmed.status()}`)
      expect(confirmed.status()).toBe(200)

      const forgotten = await memoryAction(page, id, 'forget', async () => {
        await row(page, statement).getByRole('button', { name: 'Forget', exact: true }).click()
        const dialog = dialogNamed(page, 'Forget this memory?')
        await expect(dialog).toContainText(statement)
        await dialog.getByRole('button', { name: 'Forget', exact: true }).click()
      })
      r.note(`Forget -> ${forgotten.status()}`)
      expect(forgotten.status()).toBe(200)
      await expect(dialogNamed(page, 'Forget this memory?')).toBeHidden()
      // The API lists active memories by default; the dev mock lists every status.
      if (!MOCK) await expect(row(page, statement)).toHaveCount(0)

      await page.getByLabel('Status filter').selectOption({ label: 'Archived' })
      await expect(row(page, statement)).toContainText('Archived')
      const restored = await memoryAction(page, id, 'restore', () => row(page, statement).getByRole('button', { name: 'Restore' }).click())
      r.note(`Restore -> ${restored.status()}`)
      expect(restored.status()).toBe(200)

      await page.getByLabel('Status filter').selectOption({ label: 'Active' })
      await expect(row(page, statement)).toContainText('Active')
      await expect(row(page, statement).getByRole('button', { name: 'Forget', exact: true })).toBeVisible()
    })
  })

  test('a failing review queue is shown, a 403 is silent', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const review500: InjectionSpec = { method: 'GET', path: /\/memory\/review$/, failure: { status: 500 } }
    await step(page, role, 'memory-review-500', async () => {
      const injected = await injectFailure(page, review500)
      await page.goto(site('/memory'), { waitUntil: 'domcontentloaded' })
      const alert = page.getByRole('alert').filter({ hasText: 'Could not load the review queue.' })
      await expect(alert).toBeVisible()
      await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible()
      expect(injected.hits()).toBeGreaterThan(0)
      await injected.remove()
    }, [review500])

    const review403: InjectionSpec = { method: 'GET', path: /\/memory\/review$/, failure: { status: 403, body: { success: false, message: 'Forbidden' } } }
    await step(page, role, 'memory-review-403', async () => {
      const injected = await injectFailure(page, review403)
      await page.goto(site('/memory'), { waitUntil: 'domcontentloaded' })
      await settle(page, 1_000)
      expect(injected.hits()).toBeGreaterThan(0)
      await expect(page.getByRole('tab', { name: 'Company' })).toBeVisible()
      await expect(page.getByRole('alert').filter({ hasText: 'review queue' })).toHaveCount(0)
      // An admin curates whatever the queue answers; anyone else loses the curator tabs.
      if (role === 'user') await expect(page.getByRole('tab', { name: /^Needs review/ })).toHaveCount(0)
      await injected.remove()
    }, [review403])
  })
})
