/**
 * F3 — the onboarding buddy on Home (`/`), both roles (E2E-COVERAGE-GAPS §3 F3).
 *
 * - The checklist shows five steps, each checked iff the real state says so
 *   (cross-checked here against `/settings/categories`, the onboarding GET's
 *   signals, `/scrapers`, `/chat/conversations/_list`, `/projects`).
 * - All done → "You're ready" + Hide for now + Don't show again; otherwise Skip.
 * - Skip / Don't show again are stored SERVER-side: the GET returns them, and a
 *   NEW browser context with the local cache removed shows the normal home;
 *   Account → "Setup checklist" → "Show on Home" brings the buddy back.
 * - Hide for now (documented behaviour): a one-day server-side snooze, so the
 *   buddy stays hidden after a reload and the GET carries `hidden_until`.
 *
 * Writes only the caller's OWN onboarding preference (no entity, so nothing for
 * the ledger), and restores the state it found in `afterAll` — a snooze that was
 * running is restored as a fresh one-day snooze (the server sets the end).
 */
import { expect, type Browser, type Page } from '@playwright/test'
import { test, prepareContext } from '../lib/test'
import { apiCall, listOf } from '../lib/api'
import { isRecord } from '../lib/guards'
import { storageStatePath, type Role } from '../lib/env'
import { roleOf, settle, site } from '../lib/fixtures'

const PATH = '/settings/my-onboarding'
const CACHE_PREFIX = 'voc-onboarding:'
const BUDDY = { name: 'Your setup checklist' } as const
const STEP_IDS = ['categories', 'source', 'feedback', 'assistant', 'project'] as const
type StepId = typeof STEP_IDS[number]

interface Preference { state: string; visible: boolean; signals: { feedback_present: boolean; feedback_form_configured: boolean } }

function preferenceOf(body: unknown): Preference {
  const record = isRecord(body) ? body : {}
  const signals = isRecord(record['signals']) ? record['signals'] : {}
  return {
    state: typeof record['state'] === 'string' ? record['state'] : '',
    visible: record['visible'] === true,
    signals: { feedback_present: signals['feedback_present'] === true, feedback_form_configured: signals['feedback_form_configured'] === true },
  }
}

async function getPreference(role: Role): Promise<Preference> {
  const result = await apiCall(role, 'GET', PATH)
  expect(result.status).toBe(200)
  return preferenceOf(result.body)
}

async function putState(role: Role, state: string): Promise<Preference> {
  const result = await apiCall(role, 'PUT', PATH, { state })
  expect(result.status).toBe(200)
  return preferenceOf(result.body)
}

/** What each step must show, read straight from the APIs the app reads. */
async function expectedSteps(role: Role, signals: Preference['signals']): Promise<Record<StepId, 'done' | 'todo'>> {
  const [categories, scrapers, sessions, projects] = await Promise.all([
    apiCall(role, 'GET', '/settings/categories'),
    apiCall(role, 'GET', '/scrapers'),
    apiCall(role, 'GET', '/chat/conversations/_list?kind=assistant'),
    apiCall(role, 'GET', '/projects'),
  ])
  const cats = listOf(categories.body, 'categories')
  const categoriesReady = cats.length > 0 && cats.every((c) => typeof c['product'] === 'string' && c['product'].trim() !== '')
  const source = signals.feedback_present || signals.feedback_form_configured || listOf(scrapers.body, 'scrapers').length > 0
  const ownsProject = listOf(projects.body, 'projects').some((p) => isRecord(p['access']) && p['access']['role'] === 'owner')
  const flag = (value: boolean) => (value ? 'done' : 'todo')
  return {
    categories: flag(categoriesReady),
    source: flag(source),
    feedback: flag(signals.feedback_present),
    assistant: flag(listOf(sessions.body, 'conversations').some((s) => s['kind'] === 'assistant' || s['kind'] === undefined || s['kind'] === '')),
    project: flag(ownsProject),
  }
}

async function openHome(page: Page): Promise<void> {
  await page.goto(site('/'), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
}

async function statusesOn(page: Page): Promise<Record<string, string | null>> {
  const buddy = page.getByRole('region', BUDDY)
  await expect(buddy).toBeVisible()
  // Wait until no step is still "Checking…".
  await expect(buddy.locator('[data-status="pending"]')).toHaveCount(0, { timeout: 20_000 })
  const entries = await buddy.locator('[data-step]').evaluateAll((items) =>
    items.map((li): [string, string | null] => [li.getAttribute('data-step') ?? '', li.getAttribute('data-status')]))
  return Object.fromEntries(entries)
}

/**
 * A fresh browser context on the role's saved session whose onboarding cache is
 * removed before the SPA boots, so only the server can say what Home shows.
 */
async function contextWithoutCache(browser: Browser, role: Role) {
  const context = prepareContext(await browser.newContext({ storageState: storageStatePath(role) }), role)
  await context.addInitScript((prefix: string) => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(prefix)) window.localStorage.removeItem(key)
    }
  }, CACHE_PREFIX)
  return context
}

test.describe.serial('home onboarding buddy', () => {
  const found: { state?: string } = {}

  test.beforeAll(async ({}, testInfo) => {
    found.state = (await getPreference(roleOf(testInfo))).state
  })

  test.afterAll(async ({}, testInfo) => {
    if (found.state !== undefined && found.state !== '') await putState(roleOf(testInfo), found.state)
  })

  test('checklist steps are checked iff the real state says so', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const preference = await putState(role, 'active')
    expect(preference.visible).toBe(true)
    const expected = await expectedSteps(role, preference.signals)
    await openHome(page)
    expect(await statusesOn(page)).toStrictEqual(expected)
    const done = Object.values(expected).filter((s) => s === 'done').length
    await expect(page.getByRole('region', BUDDY).getByRole('progressbar', { name: 'Setup progress' }))
      .toHaveAttribute('aria-valuetext', `${done} of ${STEP_IDS.length} done`)
  })

  test('Ready offers Hide and Don\'t show again; otherwise Skip is offered', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const preference = await putState(role, 'active')
    const expected = await expectedSteps(role, preference.signals)
    const ready = Object.values(expected).every((s) => s === 'done')
    await openHome(page)
    const buddy = page.getByRole('region', BUDDY)
    await expect(buddy).toBeVisible()
    if (ready) {
      await expect(buddy.getByRole('heading', { name: "You're ready" })).toBeVisible()
      await expect(buddy.getByRole('button', { name: 'Hide for now' })).toBeVisible()
      await expect(buddy.getByRole('button', { name: "Don't show again" })).toBeVisible()
    } else {
      await expect(buddy.getByRole('button', { name: 'Skip' })).toBeVisible()
      await expect(buddy.getByRole('button', { name: "Don't show again" })).toHaveCount(0)
    }
  })

  test('the permanent choice is stored server-side and survives a new browser; Account brings it back', async ({ page, browser }, testInfo) => {
    const role = roleOf(testInfo)
    const preference = await putState(role, 'active')
    const ready = Object.values(await expectedSteps(role, preference.signals)).every((s) => s === 'done')
    await openHome(page)
    const buddy = page.getByRole('region', BUDDY)
    // Don't show again once Ready, Skip before: both turn the buddy off for good.
    await buddy.getByRole('button', { name: ready ? "Don't show again" : 'Skip' }).click()
    await expect(page.getByRole('region', BUDDY)).toHaveCount(0)
    expect(await getPreference(role)).toMatchObject({ state: ready ? 'dismissed' : 'skipped', visible: false })

    const fresh = await contextWithoutCache(browser, role)
    try {
      const other = await fresh.newPage()
      await openHome(other)
      await expect(other.getByRole('button', { name: 'Show setup checklist' })).toBeVisible()
      await expect(other.getByRole('region', BUDDY)).toHaveCount(0)
      await expect(other.getByRole('link', { name: 'Open dashboard' })).toHaveAttribute('href', '/dashboard')

      await other.goto(site('/account'), { waitUntil: 'domcontentloaded' })
      const section = other.getByRole('region', { name: 'Setup checklist' })
      await expect(section.getByText('Turned off')).toBeVisible()
      await section.getByRole('button', { name: 'Show on Home' }).click()
      await expect(section.getByText('Showing on Home')).toBeVisible()
      expect(await getPreference(role)).toMatchObject({ state: 'active', visible: true })
      await openHome(other)
      await expect(other.getByRole('region', BUDDY)).toBeVisible()
    } finally {
      await fresh.close()
    }
  })

  test('Hide for now is a server-side snooze: still hidden after a reload', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const preference = await putState(role, 'active')
    const ready = Object.values(await expectedSteps(role, preference.signals)).every((s) => s === 'done')
    await openHome(page)
    if (ready) {
      await page.getByRole('region', BUDDY).getByRole('button', { name: 'Hide for now' }).click()
    } else {
      // Hide is only offered once Ready; set the same state the button sends.
      await putState(role, 'hidden')
    }
    const hidden = await apiCall(role, 'GET', PATH)
    expect(isRecord(hidden.body) && typeof hidden.body['hidden_until'] === 'string').toBe(true)
    expect(preferenceOf(hidden.body)).toMatchObject({ state: 'hidden', visible: false })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await settle(page, 500)
    await expect(page.getByRole('button', { name: 'Show setup checklist' })).toBeVisible()
    await expect(page.getByRole('region', BUDDY)).toHaveCount(0)
  })
})
