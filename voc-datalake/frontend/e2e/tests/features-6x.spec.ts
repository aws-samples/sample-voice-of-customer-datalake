/**
 * 6.01.00–6.04.00 features, production-safe (both roles unless a test says otherwise).
 *
 * - Scraper write rules (6.04.00, docs/scrapers.md → Write rules), admin: ONE e2e scraper
 *   (`e2e-<run id>-6x-scraper`, "Manual only" = `frequency_minutes: 0` and `enabled: false`, never
 *   run), ledger-recorded the moment it exists, created with `mode: 'create'`; `GET /scrapers` shows
 *   its computed `etag`; a second create → 409; a stale `base_etag` → 409; the current etag → 200
 *   and a new etag; an update of an unknown id → 404; then it is deleted. e2e-user: a refused body
 *   (`mode: 'bogus'`, a 400 for an admin) → 403, so the probe can never write.
 * - Colour themes (6.01.00): Account → Preferences → Colour theme. The pick is the person's own and
 *   kept in this browser (`voc-theme` in localStorage, theme/themeStore.ts), so a reload keeps it;
 *   the spec restores exactly the choice it found. Admin: Administration → General shows the
 *   "Default theme" card, read only here (never saved).
 * - Board Insights and search (6.02.00, docs/feature-requests.md): the Insights tab of the seeded
 *   Sales board, `GET /feature-requests/insights` and `GET /feature-requests/search` (no `email` /
 *   `name` anywhere in the results).
 * - Unsaved changes with two editors on one page (6.01.00), admin: brand name + Default theme draft
 *   on Administration → General, both unsaved; leaving shows ONE "Unsaved changes" dialog at a time
 *   (one per dirty editor, in turn); Cancel stays, Discard ×2 leaves; nothing is written.
 */
import { expect, type Page, type Request } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { RUN_PREFIX, apiUrl, type Role } from '../lib/env'
import { isApi, jsonOf, roleOf, runStep, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { recordCreated } from '../lib/ledger'

const SECRET_READ_POLL_MS = 30_000

/* ------------------------------------------------------------------------------------------------ */
/* Scraper write rules                                                                              */
/* ------------------------------------------------------------------------------------------------ */

const SCRAPER_ID = `${RUN_PREFIX}6x-scraper`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
const SCRAPER_NAME = `${RUN_PREFIX}6x-scraper`

/** A "Manual only" scraper that is also disabled: the scheduled ingestor never picks it up. */
function manualScraper(name: string): Record<string, unknown> {
  return {
    id: SCRAPER_ID,
    name,
    enabled: false,
    frequency_minutes: 0,
    base_url: 'https://example.com',
    urls: [],
    container_selector: 'body',
    text_selector: 'p',
  }
}

/** The stored scraper with `id` as `GET /scrapers` lists it (with its computed etag), or undefined. */
async function listedScraper(id: string): Promise<Record<string, unknown> | undefined> {
  const res = await apiCall('admin', 'GET', '/scrapers')
  expect(res.status, 'GET /scrapers').toBe(200)
  return listOf(res.body, 'scrapers').find((s) => s['id'] === id)
}

/** Poll `GET /scrapers` until `accept` holds (the configs live in a secret: a read right after a write may be stale). */
async function pollScraper(id: string, accept: (s: Record<string, unknown> | undefined) => boolean): Promise<Record<string, unknown> | undefined> {
  let last: Record<string, unknown> | undefined
  await expect.poll(async () => {
    last = await listedScraper(id)
    return accept(last)
  }, { timeout: SECRET_READ_POLL_MS, intervals: [1000, 2000, 3000] }).toBe(true)
  return last
}

const messageOf = (body: unknown): string =>
  isRecord(body) ? String(body['message'] ?? body['error'] ?? '').slice(0, 200) : String(body).slice(0, 200)

test.describe('scraper write rules (6.04.00)', () => {
  test.afterAll(async ({}, testInfo) => {
    if (roleOf(testInfo) !== 'admin') return
    // Belt and braces: the test deletes it; the shared cleanup deletes it from the ledger too.
    if ((await listedScraper(SCRAPER_ID)) !== undefined) await apiCall('admin', 'DELETE', `/scrapers/${encodeURIComponent(SCRAPER_ID)}`)
  })

  test('admin: create / duplicate create / stale update / update / unknown update / delete', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'every scraper write is admin-only (the e2e-user probe is the next test)')
    test.setTimeout(180_000)
    const { record, problems } = await runStep({
      page, role: 'admin', theme: 'dark', step: '6x-scraper-write-rules', audit: false,
      action: async (r) => {
        expect(await listedScraper(SCRAPER_ID), 'no scraper with this id before the run').toBeUndefined()

        const created = await apiCall('admin', 'POST', '/scrapers', { mode: 'create', scraper: manualScraper(SCRAPER_NAME) })
        if (created.status === 200) recordCreated('scraper', SCRAPER_ID, SCRAPER_NAME, 'admin')
        r.note(`POST /scrapers mode=create -> ${created.status} ${messageOf(created.body)}`)
        expect(created.status, messageOf(created.body)).toBe(200)

        const listed = await pollScraper(SCRAPER_ID, (s) => typeof s?.['etag'] === 'string')
        const etag = stringField(listed, 'etag') ?? ''
        expect(etag, 'GET /scrapers carries a computed etag').toMatch(/^[0-9a-f]{16}$/)
        expect(listed?.['frequency_minutes'], 'stored Manual only').toBe(0)
        expect(listed?.['enabled']).toBe(false)
        r.note(`GET /scrapers etag=${etag}`)

        const again = await apiCall('admin', 'POST', '/scrapers', { mode: 'create', scraper: manualScraper(`${SCRAPER_NAME}-dup`) })
        r.note(`POST /scrapers mode=create (same id) -> ${again.status} ${messageOf(again.body)}`)
        expect(again.status, 'a create never overwrites').toBe(409)

        const staleEtag = etag === '0000000000000000' ? '1111111111111111' : '0000000000000000'
        const stale = await apiCall('admin', 'POST', '/scrapers', { mode: 'update', base_etag: staleEtag, scraper: manualScraper(`${SCRAPER_NAME}-stale`) })
        r.note(`POST /scrapers mode=update base_etag=<stale> -> ${stale.status} ${messageOf(stale.body)}`)
        expect(stale.status, 'a stale update is refused').toBe(409)
        expect(stringField(await listedScraper(SCRAPER_ID), 'name'), 'the refused writes changed nothing').toBe(SCRAPER_NAME)

        const renamed = `${SCRAPER_NAME}-v2`
        const updated = await apiCall('admin', 'POST', '/scrapers', { mode: 'update', base_etag: etag, scraper: { ...manualScraper(renamed), etag } })
        r.note(`POST /scrapers mode=update base_etag=<current> -> ${updated.status} ${messageOf(updated.body)}`)
        expect(updated.status, messageOf(updated.body)).toBe(200)
        const after = await pollScraper(SCRAPER_ID, (s) => s?.['name'] === renamed)
        const newEtag = stringField(after, 'etag') ?? ''
        expect(newEtag).toMatch(/^[0-9a-f]{16}$/)
        expect(newEtag, 'the update gives the record a new etag').not.toBe(etag)
        r.note(`new etag=${newEtag}`)

        const nowStale = await apiCall('admin', 'POST', '/scrapers', { mode: 'update', base_etag: etag, scraper: manualScraper(`${SCRAPER_NAME}-old`) })
        r.note(`POST /scrapers mode=update base_etag=<pre-update etag> -> ${nowStale.status}`)
        expect(nowStale.status, 'the etag read before the update is stale now').toBe(409)

        const unknownId = `${SCRAPER_ID.slice(0, 54)}-missing`
        const unknown = await apiCall('admin', 'POST', '/scrapers', { mode: 'update', scraper: { ...manualScraper(`${SCRAPER_NAME}-missing`), id: unknownId } })
        r.note(`POST /scrapers mode=update (unknown id) -> ${unknown.status} ${messageOf(unknown.body)}`)
        expect(unknown.status, 'an update never creates').toBe(404)
        expect(await listedScraper(unknownId), 'the 404 created nothing').toBeUndefined()

        const deleted = await apiCall('admin', 'DELETE', `/scrapers/${encodeURIComponent(SCRAPER_ID)}`)
        r.note(`DELETE /scrapers/{id} -> ${deleted.status}`)
        expect(deleted.status).toBe(200)
        await pollScraper(SCRAPER_ID, (s) => s === undefined)
      },
    })
    expect(problems, record.screenshot ?? '').toEqual([])
  })

  test('e2e-user: POST /scrapers is admin-only (403 before the body is read)', async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'user', 'the admin-only probe is for e2e-user')
    // `mode: 'bogus'` is a 400 for an admin, so this body can never be stored whatever the gate does.
    const res = await apiCall('user', 'POST', '/scrapers', { mode: 'bogus', scraper: { id: `${SCRAPER_ID.slice(0, 55)}-refused` } })
    expect(res.status, messageOf(res.body)).toBe(403)
  })
})

/* ------------------------------------------------------------------------------------------------ */
/* Colour themes                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

const THEME_KEY = 'voc-theme'
const THEME_NAMES: Readonly<Record<string, string>> = { kiro: 'Kiro', nord: 'Nord', dracula: 'Dracula', highcontrast: 'High contrast', quick: 'Quick' }

/** The persisted colour-theme choice (`workspace` when nothing is stored, the store's default). */
async function storedChoice(page: Page): Promise<string> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), THEME_KEY)
  if (raw === null) return 'workspace'
  const parsed: unknown = JSON.parse(raw)
  const state = isRecord(parsed) ? parsed['state'] : undefined
  const choice = isRecord(state) ? state['colorTheme'] : undefined
  return typeof choice === 'string' ? choice : 'workspace'
}

const htmlAttr = (page: Page, name: string): Promise<string | null> => page.locator('html').getAttribute(name)

function themeCard(page: Page, choice: string) {
  const group = page.getByRole('radiogroup', { name: 'Colour theme' })
  return choice === 'workspace'
    ? group.getByRole('radio', { name: /^Workspace default/ })
    : group.getByRole('radio', { name: THEME_NAMES[choice] ?? choice, exact: true })
}

async function openPreferences(page: Page): Promise<void> {
  await page.goto(site('/account?tab=preferences'), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('radiogroup', { name: 'Colour theme' })).toBeVisible()
}

test.describe('colour themes (6.01.00)', () => {
  test('Account → Preferences: pick a theme, <html> carries it, a reload keeps it, then restore', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    await openPreferences(page)
    const before = await storedChoice(page)
    const shownBefore = await htmlAttr(page, 'data-color-theme')
    const modeBefore = await htmlAttr(page, 'data-mode')
    const target = shownBefore === 'nord' ? 'dracula' : 'nord'
    try {
      const { record, problems } = await runStep({
        page, role, theme: 'dark', step: `6x-theme-pick-${role}`, audit: false,
        action: async (r) => {
          r.note(`before: choice=${before} shown=${String(shownBefore)} mode=${String(modeBefore)}; picking ${target}`)
          await expect(themeCard(page, before), 'the stored choice is the checked card').toHaveAttribute('aria-checked', 'true')
          await themeCard(page, target).click()
          await expect(themeCard(page, target)).toHaveAttribute('aria-checked', 'true')
          await expect.poll(() => htmlAttr(page, 'data-color-theme')).toBe(target)
          expect(await htmlAttr(page, 'data-theme')).toBe(`${target}-${String(modeBefore)}`)
          expect(await htmlAttr(page, 'data-mode'), 'light / dark stays its own setting').toBe(modeBefore)
          expect(await storedChoice(page)).toBe(target)
          await page.reload({ waitUntil: 'domcontentloaded' })
          await expect(page.getByRole('radiogroup', { name: 'Colour theme' })).toBeVisible()
          expect(await htmlAttr(page, 'data-color-theme'), 'the reload paints the pick').toBe(target)
          await expect(themeCard(page, target)).toHaveAttribute('aria-checked', 'true')
        },
      })
      expect(problems, record.screenshot ?? '').toEqual([])
    } finally {
      await openPreferences(page)
      if ((await storedChoice(page)) !== before) await themeCard(page, before).click()
      await expect.poll(() => storedChoice(page), 'the original choice is back').toBe(before)
      await expect.poll(() => htmlAttr(page, 'data-color-theme')).toBe(shownBefore)
      await expect(themeCard(page, before)).toHaveAttribute('aria-checked', 'true')
    }
  })

  test('admin: Administration → General shows the Default theme card (read only here)', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', '/admin is admin-only')
    const writes = recordWrites(page)
    const { record, problems } = await runStep({
      page, role: 'admin', theme: 'dark', step: '6x-default-theme-card',
      action: async (r) => {
        const appearance = page.waitForResponse((res) => isApi(res, 'GET', /\/settings\/appearance$/))
        await page.goto(site('/admin?tab=general'), { waitUntil: 'domcontentloaded' })
        const body = await jsonOf(await appearance)
        const saved = String(body['default_theme'] ?? '')
        r.note(`GET /settings/appearance default_theme=${saved}`)
        expect(Object.keys(THEME_NAMES)).toContain(saved)
        await expect(page.getByRole('heading', { name: 'Default theme', exact: true })).toBeVisible()
        const group = page.getByRole('radiogroup', { name: 'Default theme' })
        await expect(group.getByRole('radio')).toHaveCount(5)
        await expect(group.getByRole('radio', { name: THEME_NAMES[saved] ?? saved, exact: true })).toHaveAttribute('aria-checked', 'true')
        await expect(page.getByRole('button', { name: 'Save theme' }), 'nothing to save before a pick').toBeDisabled()
      },
    })
    expect(problems, record.screenshot ?? '').toEqual([])
    expect(writes.map((w) => `${w.method()} ${w.url()}`)).toEqual([])
  })
})

/* ------------------------------------------------------------------------------------------------ */
/* Board Insights and search                                                                        */
/* ------------------------------------------------------------------------------------------------ */

const SALES_BOARD = { id: 'brd_sales', slug: 'sales-feature-requests' }

async function salesBoardExists(role: Role): Promise<boolean> {
  const res = await apiCall(role, 'GET', '/feature-requests/boards')
  expect(res.status, 'GET /feature-requests/boards').toBe(200)
  return listOf(res.body, 'boards').some((b) => b['board_id'] === SALES_BOARD.id && b['archived'] !== true)
}

/** Every key path in `value` named `email` or `name` (any depth). */
function personalKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => personalKeys(v, `${path}[${i}]`))
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, v]) => [
    ...(/^(email|name)$/i.test(key) ? [`${path}.${key}`] : []),
    ...personalKeys(v, `${path}.${key}`),
  ])
}

test.describe('board Insights and search (6.02.00)', () => {
  test('API: insights of the Sales board, and search answers no email or name', async ({}, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(!(await salesBoardExists(role)), 'the seeded Sales board is not on this deployment (deleted or archived)')
    const insights = await apiCall(role, 'GET', `/feature-requests/insights?board=${SALES_BOARD.slug}&days=30`)
    expect(insights.status, messageOf(insights.body)).toBe(200)
    expect(isRecord(insights.body) && isRecord(insights.body['totals'])).toBe(true)
    if (isRecord(insights.body)) {
      expect(insights.body['window_days']).toBe(30)
      expect(isRecord(insights.body['board']) ? insights.body['board']['id'] : undefined).toBe(SALES_BOARD.id)
      expect(Array.isArray(insights.body['top'])).toBe(true)
    }
    const search = await apiCall(role, 'GET', '/feature-requests/search?q=e2e&limit=5')
    expect(search.status, messageOf(search.body)).toBe(200)
    const items = listOf(search.body, 'items')
    expect(items.length).toBeLessThanOrEqual(5)
    expect(personalKeys(search.body), 'search results carry no email or name').toEqual([])
  })

  test('UI: /feature-requests?tab=insights shows totals and the most-supported list', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(!(await salesBoardExists(role)), 'the seeded Sales board is not on this deployment (deleted or archived)')
    const { record, problems } = await runStep({
      page, role, theme: 'dark', step: `6x-board-insights-${role}`,
      action: async (r) => {
        const loaded = page.waitForResponse((res) => isApi(res, 'GET', /\/feature-requests\/insights$/)
          && new URL(res.url()).searchParams.get('board') === SALES_BOARD.id)
        await page.goto(site(`/feature-requests?tab=insights&board=${SALES_BOARD.id}&days=30`), { waitUntil: 'domcontentloaded' })
        const res = await loaded
        expect(res.status()).toBe(200)
        const body = await jsonOf(res)
        const totals = isRecord(body['totals']) ? body['totals'] : {}
        const requests = Number(totals['requests'] ?? 0)
        r.note(`GET /feature-requests/insights board=${SALES_BOARD.id} days=30 -> requests=${requests} top=${Array.isArray(body['top']) ? body['top'].length : 0}`)
        await expect(page.getByRole('tab', { name: 'Insights' })).toHaveAttribute('aria-selected', 'true')
        await expect(page.getByLabel('Created in')).toHaveValue('30')
        if (requests === 0) {
          await expect(page.getByTestId('fr-insights-empty')).toBeVisible()
          return
        }
        const tiles = page.getByTestId('fr-insights-totals')
        await expect(tiles).toBeVisible()
        await expect(tiles.locator('dd').first()).toHaveText(requests.toLocaleString('en'))
        const top = page.getByRole('region', { name: 'Most supported requests' })
        await expect(top).toBeVisible()
        const topCount = Array.isArray(body['top']) ? body['top'].length : 0
        if (topCount > 0) await expect(top.getByRole('listitem')).toHaveCount(topCount)
      },
    })
    expect(problems, record.screenshot ?? '').toEqual([])
  })
})

/* ------------------------------------------------------------------------------------------------ */
/* Unsaved changes with two editors on one page                                                     */
/* ------------------------------------------------------------------------------------------------ */

const GUARD = 'Unsaved changes'

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

const sidebarHome = (page: Page) => page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Home', exact: true }).first()

test.describe('unsaved changes, two editors on one page (6.01.00)', () => {
  test('admin: brand + Default theme both unsaved → one dialog at a time; nothing is written', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'the only page with two editors that open without a save is Administration → General (admin-only)')
    const writes = recordWrites(page)
    const { record, problems } = await runStep({
      page, role: 'admin', theme: 'dark', step: '6x-unsaved-two-editors', audit: false,
      action: async (r) => {
        await page.goto(site('/admin?tab=general'), { waitUntil: 'domcontentloaded' })
        await settle(page, 600)
        const brand = page.getByLabel('Brand Name')
        await expect(brand).toBeVisible()
        const brandBefore = await brand.inputValue()
        await brand.fill(`${brandBefore} e2e-unsaved`)
        const group = page.getByRole('radiogroup', { name: 'Default theme' })
        await expect(group.getByRole('radio')).toHaveCount(5)
        await group.locator('[role="radio"][aria-checked="false"]').first().click()
        await expect(page.getByRole('button', { name: 'Save theme' }), 'the theme card is dirty').toBeEnabled()

        await sidebarHome(page).click()
        await expect(dialogNamed(page, GUARD)).toHaveCount(1)
        await dialogNamed(page, GUARD).getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(dialogNamed(page, GUARD)).toHaveCount(0)
        await expect(page).toHaveURL(/\/admin/)
        await expect(brand, 'Cancel keeps the brand edit').toHaveValue(`${brandBefore} e2e-unsaved`)
        await expect(page.getByRole('button', { name: 'Save theme' }), 'Cancel keeps the theme pick').toBeEnabled()

        await sidebarHome(page).click()
        await expect(dialogNamed(page, GUARD)).toHaveCount(1)
        await dialogNamed(page, GUARD).getByRole('button', { name: 'Discard', exact: true }).click()
        // The second dirty editor asks in turn: again exactly one dialog, never two stacked.
        await expect(dialogNamed(page, GUARD)).toHaveCount(1)
        r.note('second editor asked after the first Discard')
        await dialogNamed(page, GUARD).getByRole('button', { name: 'Discard', exact: true }).click()
        await expect(dialogNamed(page, GUARD)).toHaveCount(0)
        await expect(page).toHaveURL(/\/$/)
      },
    })
    expect(problems, record.screenshot ?? '').toEqual([])
    expect(writes.map((w) => `${w.method()} ${w.url()}`), 'no brand or theme write').toEqual([])
  })
})
