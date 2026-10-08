/**
 * E2E F6 — the shared unsaved-changes guard (one dialog, "Unsaved changes",
 * Save / Discard / Cancel), both roles where they can edit.
 *
 * Given an editor with a changed field, When the user leaves by a sidebar link,
 * the Back button, a `?tab=` switch that drops the draft, or closing the tab,
 * Then the same named dialog (or, for tab close, the browser's own prompt)
 * appears. Cancel stays with the edits; Discard leaves and sends nothing;
 * Save sends the PUT, then leaves.
 *
 * Writes: ONLY the e2e-admin agent this spec creates (`e2e-<run id>-guard-agent`,
 * ledger-recorded, archived in afterAll) is ever saved. Admin brand settings and
 * the user's objectives are exercised with Cancel / Discard only — the spec
 * fails if any write request is sent for them.
 */
import { expect, type Page, type Request } from '@playwright/test'
import { test } from '../lib/test'
import { agentName, archiveE2eAgent, createE2eAgent, type E2eAgent } from '../lib/agentFixture'
import { dialogNamed } from '../lib/dialogs'
import { apiUrl } from '../lib/env'
import { escapeRegExp, isApi, roleOf, settle, site } from '../lib/fixtures'

const GUARD = 'Unsaved changes'

const guard = (page: Page) => dialogNamed(page, GUARD)
const sidebarHome = (page: Page) => page.locator('aside').getByRole('link', { name: 'Home', exact: true }).first()

/** Every write the page sends to the API from now on (the assistant's own session saves excluded). */
function recordWrites(page: Page): Request[] {
  const writes: Request[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith(apiUrl()) || request.method() === 'GET' || request.method() === 'OPTIONS') return
    if (/\/chat\//.test(request.url())) return
    writes.push(request)
  })
  return writes
}

async function expectGuardButtons(page: Page): Promise<void> {
  await expect(guard(page)).toBeVisible()
  for (const name of ['Save', 'Discard', 'Cancel']) {
    await expect(guard(page).getByRole('button', { name, exact: true })).toBeVisible()
  }
}

let agent: E2eAgent | undefined

test.beforeAll(async ({}, testInfo) => {
  if (roleOf(testInfo) === 'admin') agent = await createE2eAgent('guard-agent')
})

test.afterAll(async () => {
  await archiveE2eAgent(agent)
})

test.describe('agent page (e2e-admin, e2e-owned agent)', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin' || agent === undefined, 'only e2e-admin edits agents')
  })

  /**
   * Opens the e2e agent by IN-APP navigation (Home → sidebar "Autonomous agents" → the agent's
   * row) and edits its name. Every history entry is the SPA's own, so Back is a router POP the
   * in-app guard holds. QA 3.00.00 S6: two `page.goto`s made Back a cross-document navigation,
   * which raises the browser's native beforeunload prompt instead (F6-a6 covers that one).
   */
  async function openAgentWithEdit(page: Page): Promise<string> {
    await page.goto(site('/'))
    await page.locator('aside').getByRole('link', { name: 'Autonomous agents', exact: true }).first().click()
    await expect(page).toHaveURL(/\/agents$/)
    await page.getByRole('link', { name: new RegExp(escapeRegExp(agent?.name ?? '')) }).first().click()
    await expect(page).toHaveURL(new RegExp(`/agents/${escapeRegExp(agent?.id ?? '')}`))
    const name = page.getByLabel('Name', { exact: true })
    await expect(name).toHaveValue(agent?.name ?? '')
    await name.fill(`${agent?.name ?? ''}-edited`)
    return page.url()
  }

  test('F6-a1: a sidebar link opens the dialog; Cancel stays with the edits', async ({ page }) => {
    const here = await openAgentWithEdit(page)
    await sidebarHome(page).click()
    await expectGuardButtons(page)
    await guard(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(guard(page)).toBeHidden()
    expect(page.url()).toBe(here)
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(`${agent?.name ?? ''}-edited`)
  })

  test('F6-a2: Back (in-app history) opens the dialog; Discard leaves without a PUT', async ({ page }) => {
    const writes = recordWrites(page)
    await openAgentWithEdit(page)
    await page.goBack()
    await expectGuardButtons(page)
    await guard(page).getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(page).toHaveURL(/\/agents$/)
    expect(writes.map((r) => `${r.method()} ${r.url()}`)).toEqual([])
    expect(await agentName(agent?.id ?? '')).toBe(agent?.name)
  })

  test('F6-a3: a ?tab= switch that drops the draft asks; Escape is Cancel', async ({ page }) => {
    await openAgentWithEdit(page)
    // Config tabs share the draft and switch freely…
    await page.getByRole('tab', { name: /Instructions/ }).click()
    await expect(guard(page)).toBeHidden()
    // …the Runs tab would drop it.
    await page.getByRole('tab', { name: /Runs/ }).click()
    await expectGuardButtons(page)
    await page.keyboard.press('Escape')
    await expect(guard(page)).toBeHidden()
    await expect(page).toHaveURL(/tab=instructions/)
  })

  test('F6-a4: Save sends the PUT, then navigates', async ({ page }) => {
    await openAgentWithEdit(page)
    const saved = `${agent?.name ?? ''}-saved`
    await page.getByLabel('Name', { exact: true }).fill(saved)
    await page.getByRole('link', { name: 'All agents' }).click()
    await expectGuardButtons(page)
    const put = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/agents/${agent?.id ?? ''}$`)))
    await guard(page).getByRole('button', { name: 'Save', exact: true }).click()
    expect((await put).status()).toBe(200)
    await expect(page).toHaveURL(/\/agents$/)
    expect(await agentName(agent?.id ?? '')).toBe(saved)
    // Still e2e-named, so the archive in afterAll applies; keep the fixture in step.
    if (agent !== undefined) agent = { ...agent, name: saved }
  })

  test('F6-a5: closing the tab while dirty raises the browser prompt', async ({ page }) => {
    await openAgentWithEdit(page)
    const prompt = page.waitForEvent('dialog')
    await page.close({ runBeforeUnload: true })
    const dialog = await prompt
    expect(dialog.type()).toBe('beforeunload')
    await dialog.accept()
  })

  test('F6-a6: a full reload while dirty raises the native beforeunload prompt, not the in-app dialog', async ({ page }) => {
    const writes = recordWrites(page)
    const here = await openAgentWithEdit(page)
    const prompts: string[] = []
    page.on('dialog', (dialog) => {
      prompts.push(dialog.type())
      void dialog.dismiss()
    })
    // A document navigation, not a router one: the browser asks; dismissing it keeps the page.
    void page.evaluate(() => { window.location.reload() }).catch(() => undefined)
    await expect.poll(() => prompts).toEqual(['beforeunload'])
    await expect(guard(page)).toHaveCount(0)
    expect(page.url()).toBe(here)
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(`${agent?.name ?? ''}-edited`)
    expect(writes.map((r) => `${r.method()} ${r.url()}`)).toEqual([])
  })
})

test.describe('admin settings (Cancel / Discard only, never saved)', () => {
  test('F6-s1: brand edits ask before leaving; nothing is written', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', '/admin is admin-only')
    const writes = recordWrites(page)
    await page.goto(site('/admin'))
    const brand = page.getByLabel('Brand Name')
    await expect(brand).toBeVisible()
    await brand.fill(`${await brand.inputValue()} e2e-unsaved`)
    await sidebarHome(page).click()
    await expectGuardButtons(page)
    await guard(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(/\/admin/)
    await sidebarHome(page).click()
    await guard(page).getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    expect(writes.map((r) => `${r.method()} ${r.url()}`)).toEqual([])
  })
})

test.describe('account objectives (both roles, Cancel / Discard only)', () => {
  test('F6-o1: an unsaved objective asks before leaving; nothing is written', async ({ page }) => {
    const writes = recordWrites(page)
    await page.goto(site('/account?tab=objectives'))
    await settle(page)
    await page.getByRole('button', { name: 'Add objective' }).click()
    await sidebarHome(page).click()
    await expectGuardButtons(page)
    await guard(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(/\/account/)
    await sidebarHome(page).click()
    await guard(page).getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    expect(writes.map((r) => `${r.method()} ${r.url()}`)).toEqual([])
  })
})
