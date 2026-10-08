/**
 * P3 — Account / Company "My objectives & KPIs" (`/settings/my-context`), both roles.
 *
 * The caller's OWN context only: it is read first, an e2e-named objective with a
 * KPI is added and saved through the UI on `/account?tab=objectives` ("Saved!"),
 * the API and a reload show it, and then the ORIGINAL objectives are put back
 * (PUT of exactly what was read) and proven equal. The restore also runs in
 * `afterAll`, so a failure half-way never leaves the e2e objective behind.
 * `/company?tab=mine` must land on the same section (the Company page has no
 * objectives tab of its own any more).
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { RUN_PREFIX, type Role } from '../lib/env'
import { isRecord } from '../lib/guards'
import { roleOf, runStep, settle, site } from '../lib/fixtures'

const PATH = '/settings/my-context'

/** The objectives array of a my-context body ([] when absent). */
function objectivesOf(body: unknown): unknown[] {
  return isRecord(body) && Array.isArray(body['objectives']) ? body['objectives'] : []
}

const titlesOf = (objectives: unknown[]): string[] =>
  objectives.flatMap((o) => (isRecord(o) && typeof o['title'] === 'string' ? [o['title']] : []))

async function readObjectives(role: Role): Promise<unknown[]> {
  const res = await apiCall(role, 'GET', PATH)
  expect(res.status, `GET ${PATH}`).toBe(200)
  return objectivesOf(res.body)
}

/** The values of every "Objective title" input on the page (an input's value is not its text). */
async function objectiveTitlesShown(page: Page): Promise<string[]> {
  const inputs = await page.getByRole('textbox', { name: 'Objective title' }).all()
  return Promise.all(inputs.map((input) => input.inputValue()))
}

async function addObjectiveInUi(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Add objective' }).click()
  await page.getByRole('textbox', { name: 'Objective title' }).last().fill(title)
  // The new objective is the last fieldset; give it one KPI so the save carries one.
  const objective = page.getByRole('group').filter({ has: page.getByRole('textbox', { name: 'Objective title' }) }).last()
  await objective.getByRole('button', { name: 'Add KPI' }).click()
  await objective.getByRole('textbox', { name: 'KPI name' }).last().fill('e2e kpi')
  await objective.getByRole('textbox', { name: 'Target' }).last().fill('10')
}

test.describe('my objectives & KPIs (my-context)', () => {
  const original = new Map<Role, unknown[]>()

  test.afterAll(async () => {
    for (const [role, objectives] of original) await apiCall(role, 'PUT', PATH, { objectives })
  })

  test('save through the UI, then restore the original values', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const before = await readObjectives(role)
    original.set(role, before)
    const title = `${RUN_PREFIX}objective-${role}`

    const { record, problems } = await runStep({
      page, role, theme: 'dark', step: 'p3-account-my-context',
      action: async (recorder) => {
        await page.goto(site('/account?tab=objectives'), { waitUntil: 'domcontentloaded' })
        await settle(page, 600)
        await expect(page.getByRole('heading', { name: 'My objectives & KPIs' })).toBeVisible()
        const save = page.getByRole('button', { name: 'Save Changes' })
        await expect(save, 'nothing to save before an edit').toBeDisabled()
        await addObjectiveInUi(page, title)
        const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(PATH))
        await save.click()
        expect((await saved).status()).toBe(200)
        await expect(page.getByRole('status').filter({ hasText: 'Saved!' })).toBeVisible()
        recorder.note(`saved ${before.length + 1} objectives`)
      },
    })
    expect(problems, record.screenshot ?? '').toEqual([])

    const afterSave = await readObjectives(role)
    expect(titlesOf(afterSave)).toEqual([...titlesOf(before), title])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('textbox', { name: 'Objective title' }).last()).toHaveValue(title)

    // Restore exactly what was there, and prove it.
    const restored = await apiCall(role, 'PUT', PATH, { objectives: before })
    expect(restored.status).toBe(200)
    expect(await readObjectives(role)).toEqual(before)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'My objectives & KPIs' })).toBeVisible()
    await expect.poll(() => objectiveTitlesShown(page), 'the e2e objective is gone from the page').not.toContain(title)
    expect(titlesOf(await readObjectives(role))).not.toContain(title)
  })

  test('/company?tab=mine opens the same section on Account', async ({ page }) => {
    await page.goto(site('/company?tab=mine'), { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(/\/account\?tab=objectives/)
    await expect(page.getByRole('heading', { name: 'My objectives & KPIs' })).toBeVisible()
    await page.goto(site('/company?tab=vision'), { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('tab', { name: 'Vision & objectives' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'My objectives' })).toHaveCount(0)
  })
})
