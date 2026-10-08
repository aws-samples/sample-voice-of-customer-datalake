/**
 * QA track s1, part 1 (admin, E2E_TRACK=s1 only):
 *  1. A web scraper created end to end with Analyze URL on a public page and
 *     saved as "Manual only" (never scheduled, never run), then every
 *     connector tile of "Add Data Source" opened and closed without saving.
 *  2. EXACTLY ten `[e2e-qa]` comments through Manual Import (paste → AI parse
 *     → preview → confirm), polled until enriched, then found on the feedback
 *     detail page, Categories and Data Explorer. The import is guarded so a
 *     second run never imports again (feedback has no delete route).
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test'
import { test } from '../lib/test'
import { isRecord } from '../lib/guards'
import { apiCall, listOf, stringField } from '../lib/api'
import { isApi, jsonOf, settle, site } from '../lib/fixtures'
import { dialogNamed } from '../lib/dialogs'
import { recordCreated } from '../lib/ledger'
import { analyzeManualScraper } from '../lib/scrapers'
import { SCREENS_DIR } from '../lib/env'
import path from 'node:path'
import {
  COMMENTS, IMPORT_CHANNEL, IMPORT_SOURCE_URL, NAME, TEXT_PREFIX,
  readState, s1Only, s1Step, snippet, writeState, type ImportedItem,
} from './s1-shared'

const ANALYZE_URL = 'https://en.wikipedia.org/wiki/Customer_review'
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 12 * 60_000
/** closeDialog: Escape / Cancel / Close rounds, and the pause after each. */
const CLOSE_ATTEMPTS = 6
const CLOSE_SETTLE_MS = 400

/** Whether `locator` becomes visible within `ms` (no throw). */
const shownWithin = (locator: Locator, ms: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false)

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** ScraperEditor.tsx names itself "New Scraper" for every scraper template tile. */
const SCRAPER_EDITOR = 'New Scraper'

/**
 * The dialog an Add Data Source tile opens, by accessible name (never by
 * position: the floating assistant panel is a dialog too). A plugin, the
 * generator and the manual-input dialogs carry the tile's title (the CSV one
 * in lower case, "CSV upload"); a scraper template opens the scraper editor.
 */
const tileDialog = (page: Page, title: string): Locator =>
  dialogNamed(page, new RegExp(`^(${escapeRegExp(title)}|${SCRAPER_EDITOR})$`, 'i'))

/** Keys of the comments whose text is not visible on the current page. */
async function missingOnPage(page: Page): Promise<string[]> {
  const missing: string[] = []
  for (const c of COMMENTS) {
    if (!await page.getByText(snippet(c.text)).first().isVisible().catch(() => false)) missing.push(c.key)
  }
  return missing
}

async function openAddSource(page: Page): Promise<Locator> {
  await page.goto(site('/scrapers'), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
  await page.getByRole('button', { name: 'New Source' }).click()
  const selector = page.getByRole('dialog', { name: 'Add Data Source' })
  await expect(selector).toBeVisible()
  return selector
}

/**
 * Closes `opened` (a dialog found by name) the designed way and reports how:
 * Escape first; a form that is deliberately not Escape-dismissable (an open
 * app editor, the scraper editor) is left with its own Cancel, then Close.
 */
async function closeDialog(page: Page, opened: Locator): Promise<{ closed: boolean; how: string[] }> {
  const how: string[] = []
  for (let i = 0; i < CLOSE_ATTEMPTS; i += 1) {
    if (await opened.count() === 0) return { closed: true, how }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(CLOSE_SETTLE_MS)
    if (await opened.count() === 0) { how.push('Escape'); continue }
    const button = opened.getByRole('button', { name: /^(Cancel|Close)$/ }).filter({ visible: true }).first()
    if (!await button.isVisible().catch(() => false)) break
    how.push(`${await button.innerText()} button`)
    await button.click()
    await page.waitForTimeout(CLOSE_SETTLE_MS)
  }
  return { closed: await opened.count() === 0, how }
}

test.describe('s1 data: connectors and the ten-comment import', () => {
  test.beforeEach(({}, testInfo) => s1Only(testInfo))

  test('S1-T1 connector: analyze-url scraper saved Manual only', async ({ page }) => {
    await s1Step(page, '01-scraper-analyze-save', ['scrapers-api'], async (r) => {
      const selector = await openAddSource(page)
      await selector.getByRole('button', { name: /Custom \(CSS Selectors\)/ }).first().click()
      const editor = dialogNamed(page, SCRAPER_EDITOR)
      const analyzeRes = await analyzeManualScraper(page, editor, r, { name: NAME.scraper, url: ANALYZE_URL })
      expect(analyzeRes.status()).toBeLessThan(300)
      await settle(page, 800)
      // Auto-detect may rewrite fields: re-pin Manual only right before saving.
      await editor.getByLabel('Frequency').selectOption('0')
      await page.screenshot({ path: path.join(SCREENS_DIR, 'admin-dark-s1-01-scraper-editor-analyzed.png') })
      const saved = page.waitForResponse((res) => isApi(res, 'POST', /\/scrapers$/))
      await editor.getByRole('button', { name: 'Save Scraper' }).click()
      const saveRes = await saved
      const body = await jsonOf(saveRes)
      const id = stringField(isRecord(body['scraper']) ? body['scraper'] : undefined, 'id')
      r.note(`POST /scrapers -> ${saveRes.status()} id=${id ?? '?'}`)
      expect(saveRes.status()).toBeLessThan(300)
      expect(id).toBeTruthy()
      if (id === undefined) return
      recordCreated('scraper', id, NAME.scraper)
      writeState({ scraperId: id })
      const listed = listOf((await apiCall('admin', 'GET', '/scrapers')).body, 'scrapers').find((s) => s['id'] === id)
      r.note(`GET /scrapers: listed=${listed !== undefined} frequency_minutes=${String(listed?.['frequency_minutes'])} enabled=${String(listed?.['enabled'])} url=${String(listed?.['base_url'] ?? listed?.['url'] ?? '')}`)
      expect(listed, 'saved scraper is listed').toBeDefined()
      if (Number(listed?.['frequency_minutes'] ?? 0) !== 0) {
        // Never leave a scheduled scraper behind: delete it now and fail.
        const del = await apiCall('admin', 'DELETE', `/scrapers/${encodeURIComponent(id)}`)
        throw new Error(`scraper saved with frequency_minutes=${String(listed?.['frequency_minutes'])} (deleted: ${del.status})`)
      }
      await settle(page)
      const card = page.locator('.card').filter({ hasText: NAME.scraper }).first()
      const shownAfterSave = await shownWithin(card, 15_000)
      if (!shownAfterSave) {
        // The SPA's own refetch right after the save answered without the new
        // scraper (seen on 2.13.00). Record it, then prove a manual Refresh shows it.
        await page.screenshot({ path: path.join(SCREENS_DIR, 'admin-dark-s1-01-scraper-missing-after-save.png') })
        await page.getByRole('button', { name: 'Refresh', exact: true }).click()
        const shownAfterRefresh = await shownWithin(card, 15_000)
        r.note(`new scraper NOT listed by the post-save refetch; after Refresh: ${shownAfterRefresh ? 'listed' : 'still missing'}`)
        throw new Error('saved scraper missing from the list until a manual Refresh (stale post-save refetch)')
      }
      r.note('new scraper listed right after save')
    })
  })

  test('S1-T2 connector: open every Add Data Source tile and its dialog (no save)', async ({ page }) => {
    test.setTimeout(300_000)
    await s1Step(page, '02-connector-dialogs', ['integrations-api', 'scrapers-api'], async (r) => {
      const selector = await openAddSource(page)
      const titles = (await selector.locator('section button').allInnerTexts()).map((t) => (t.split('\n')[0] ?? '').trim()).filter((t) => t !== '')
      r.note(`tiles: ${titles.join(' | ')}`)
      expect(titles.length).toBeGreaterThan(3)
      await closeDialog(page, selector)
      const writes: string[] = []
      const watchWrites = (res: Response): void => {
        const method = res.request().method()
        if (method !== 'GET' && method !== 'OPTIONS' && isApi(res, method, /./)) writes.push(`${method} ${new URL(res.url()).pathname} -> ${res.status()}`)
      }
      page.on('response', watchWrites)
      const failures: string[] = []
      for (const title of titles) {
        const tiles = await openAddSource(page)
        await tiles.locator('section button').filter({ hasText: title }).first().click()
        await settle(page, 1_200)
        const opened = tileDialog(page, title)
        const heading = (await opened.getByRole('heading').first().innerText().catch(() => '')).trim()
        const label = title.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
        await page.screenshot({ path: path.join(SCREENS_DIR, `admin-dark-s1-02-tile-${label}.png`) })
        // Plugin dialogs: show the add-app form too, then leave it unsaved.
        const addApp = opened.getByRole('button', { name: /^(Add App|Add your first app)$/ }).first()
        if (await addApp.isVisible().catch(() => false) && await addApp.isEnabled()) {
          await addApp.click()
          await settle(page, 500)
          await page.screenshot({ path: path.join(SCREENS_DIR, `admin-dark-s1-02-tile-${label}-add-form.png`) })
          r.note(`${title}: add-app form opened (not saved)`)
        }
        const { closed, how } = await closeDialog(page, opened)
        r.note(`${title}: dialog "${heading}" opened; closed=${closed} via ${how.join(' → ')}`)
        if (heading === '') failures.push(`${title}: no dialog heading`)
        if (!closed) {
          failures.push(`${title}: the dialog could not be closed`)
          await page.goto(site('/scrapers'), { waitUntil: 'domcontentloaded' })
        }
      }
      page.off('response', watchWrites)
      r.note(`writes during the tile sweep: ${writes.length === 0 ? 'none' : writes.join('; ')}`)
      expect(writes, 'opening connector dialogs must not write').toEqual([])
      expect(failures).toEqual([])
    })
  })

  test('S1-T3 import: exactly ten [e2e-qa] comments via Manual Import, preview, confirm', async ({ page }) => {
    test.setTimeout(300_000)
    const already = readState().importAttemptedAt
    test.skip(already !== undefined, `import already attempted at ${already ?? ''}; never import twice`)
    await s1Step(page, '03-import-preview', ['manual-import-api', 'manual-import-processor'], async (r) => {
      // Belt and braces: the table must not already hold [e2e-qa] items (from any run).
      const existing = await apiCall('admin', 'GET', '/feedback/search?q=Zebrafin&days=0')
      const hits = listOf(existing.body, 'items').filter((i) => (stringField(i, 'original_text') ?? '').startsWith(TEXT_PREFIX))
      r.note(`pre-check GET /feedback/search?q=Zebrafin -> ${existing.status}, [e2e-qa] hits=${hits.length}`)
      expect(existing.status).toBe(200)
      if (hits.length > 0) throw new Error('[e2e-qa] items already exist: refusing to import again')

      const selector = await openAddSource(page)
      await selector.locator('section button').filter({ hasText: 'Manual Import' }).first().click()
      const modal = page.getByRole('dialog', { name: 'Manual Import' })
      await expect(modal).toBeVisible()
      await modal.getByLabel(/Source URL/).fill(IMPORT_SOURCE_URL)
      await expect(modal.getByText(/Detected:/)).toBeVisible()
      await modal.getByLabel(/Paste reviews/).fill(COMMENTS.map((c) => c.text).join('\n\n'))
      const parse = page.waitForResponse((res) => isApi(res, 'POST', /\/scrapers\/manual\/parse$/))
      const t0 = Date.now()
      await modal.getByRole('button', { name: /^Parse Reviews/ }).click()
      const parseRes = await parse
      const parseBody = await jsonOf(parseRes)
      const jobId = typeof parseBody['job_id'] === 'string' ? parseBody['job_id'] : undefined
      r.note(`POST /scrapers/manual/parse -> ${parseRes.status()} source_origin=${String(parseBody['source_origin'])} job=${jobId ?? '?'}`)
      expect(parseRes.status()).toBe(200)
      expect(parseBody['source_origin']).toBe(IMPORT_CHANNEL)
      writeState({ importParseJobId: jobId })
      await expect(modal.getByRole('heading', { name: /reviews found|No reviews detected/ })).toBeVisible({ timeout: 150_000 })
      r.note(`AI parse finished in ${Date.now() - t0}ms: ${await modal.getByRole('heading', { name: /reviews found|No reviews detected/ }).innerText()}`)
      const boxes = modal.locator('textarea')
      const count = await boxes.count()
      r.note(`preview reviews: ${count}`)
      expect(count, 'the AI parse must find exactly ten reviews').toBe(COMMENTS.length)
      // The parser may trim or reword: pin each preview text to the exact comment (edit-in-preview is part of the flow).
      const values = await boxes.evaluateAll((els) => els.map((e) => (e instanceof HTMLTextAreaElement ? e.value : '')))
      let edited = 0
      for (const [index, comment] of COMMENTS.entries()) {
        const at = values.findIndex((v) => v.includes(comment.key))
        const target = at === -1 ? index : at
        if (values[target]?.trim() !== comment.text) {
          await boxes.nth(target).fill(comment.text)
          edited += 1
        }
      }
      r.note(`preview texts pinned to the exact comments: ${edited} edited`)
      // The confirm route requires a date on every review (400 otherwise), but the
      // preview neither marks it required nor shows that error: set today's date.
      const dates = modal.locator('input[type="date"]')
      const today = new Date().toISOString().slice(0, 10)
      const dateCount = await dates.count()
      for (let i = 0; i < dateCount; i += 1) {
        if (await dates.nth(i).inputValue() === '') await dates.nth(i).fill(today)
      }
      r.note(`review dates set to ${today} where empty (${dateCount} date fields)`)
      const final = await boxes.evaluateAll((els) => els.map((e) => (e instanceof HTMLTextAreaElement ? e.value.trim() : '')))
      expect([...final].sort()).toEqual(COMMENTS.map((c) => c.text).sort())
      await page.screenshot({ path: path.join(SCREENS_DIR, 'admin-dark-s1-03-import-preview-full.png'), fullPage: true })
    }, { audit: false })

    await s1Step(page, '04-import-confirm', ['manual-import-api'], async (r) => {
      const modal = page.getByRole('dialog', { name: 'Manual Import' })
      const button = modal.getByRole('button', { name: `Import ${COMMENTS.length} Reviews` })
      await expect(button).toBeEnabled()
      writeState({ importAttemptedAt: new Date().toISOString() })
      const confirm = page.waitForResponse((res) => isApi(res, 'POST', /\/scrapers\/manual\/confirm$/))
      const confirmedAt = Date.now()
      await button.click()
      const res = await confirm
      writeState({ importConfirmedAtMs: confirmedAt, importConfirmStatus: res.status() })
      // On success the SPA reloads the page at once (ManualImportModal.handleConfirm),
      // which discards the response body; the count is proven by the poll in S1-T4.
      const body = await jsonOf(res)
      const imported = typeof body['imported_count'] === 'number' ? body['imported_count'] : null
      if (imported !== null) writeState({ importedCount: imported })
      r.note(`POST /scrapers/manual/confirm -> ${res.status()} imported_count=${imported ?? 'unreadable (page reloaded)'}`)
      expect(res.status()).toBe(200)
      if (imported !== null) expect(imported).toBe(COMMENTS.length)
      await settle(page)
    })
  })

  test('S1-T4 import: poll until all ten are enriched; visible in Feedback, Categories, Data Explorer', async ({ page }) => {
    test.setTimeout(POLL_TIMEOUT_MS + 240_000)
    const confirmedAt = readState().importConfirmedAtMs
    test.skip(confirmedAt === undefined, 'no confirmed import')
    const since = confirmedAt ?? 0

    await s1Step(page, '05-import-poll-enriched', ['feedback-processor', 'aggregation-processor', 'metrics-api'], async (r) => {
      const recorded = readState().items ?? []
      if (recorded.length === COMMENTS.length) {
        // A re-run: the latencies were measured when the import happened; only re-verify.
        for (const item of recorded) {
          const res = await apiCall('admin', 'GET', `/feedback/${item.feedbackId}`)
          const body = isRecord(res.body) && isRecord(res.body['feedback']) ? res.body['feedback'] : isRecord(res.body) ? res.body : undefined
          r.note(`re-verify GET /feedback/${item.feedbackId} -> ${res.status} sentiment=${stringField(body, 'sentiment_label') ?? '?'} category=${stringField(body, 'category') ?? '?'}`)
          expect(res.status).toBe(200)
        }
        return
      }
      const found = new Map<string, ImportedItem>()
      const deadline = Date.now() + POLL_TIMEOUT_MS
      let polls = 0
      while (found.size < COMMENTS.length && Date.now() < deadline) {
        polls += 1
        const [bySource, bySearch] = await Promise.all([
          apiCall('admin', 'GET', '/feedback?source=manual_import&days=2&limit=100'),
          apiCall('admin', 'GET', '/feedback/search?q=Zebrafin&days=2'),
        ])
        for (const item of [...listOf(bySource.body, 'items'), ...listOf(bySearch.body, 'items')]) {
          const text = stringField(item, 'original_text') ?? ''
          const comment = COMMENTS.find((c) => text.trim() === c.text)
          const id = stringField(item, 'feedback_id')
          const sentiment = stringField(item, 'sentiment_label')
          const category = stringField(item, 'category')
          if (comment === undefined || id === undefined || sentiment === undefined || category === undefined || found.has(comment.key)) continue
          const processedAt = Date.parse(stringField(item, 'processed_at') ?? '')
          found.set(comment.key, {
            feedbackId: id, key: comment.key, sentiment, category,
            apiVisibleMs: Date.now() - since,
            processedMs: Number.isNaN(processedAt) ? null : processedAt - since,
          })
          r.note(`enriched after ${Date.now() - since}ms (poll ${polls}): ${id} "${comment.key}" sentiment=${sentiment} category=${category} channel=${stringField(item, 'source_channel') ?? '?'} platform=${stringField(item, 'source_platform') ?? '?'}`)
        }
        if (found.size < COMMENTS.length) await page.waitForTimeout(POLL_INTERVAL_MS)
      }
      const items = COMMENTS.map((c) => found.get(c.key)).filter((i): i is ImportedItem => i !== undefined)
      writeState({ items })
      r.note(`enriched ${items.length}/${COMMENTS.length} after ${polls} polls`)
      expect(items.length).toBe(COMMENTS.length)
    })

    await s1Step(page, '06-visible-feedback-detail', ['metrics-api'], async (r) => {
      const items = readState().items ?? []
      for (const item of items) {
        await page.goto(site(`/feedback/${item.feedbackId}`), { waitUntil: 'domcontentloaded' })
        const comment = COMMENTS.find((c) => c.key === item.key)
        await expect(page.getByText(comment === undefined ? item.key : snippet(comment.text)).first()).toBeVisible({ timeout: 20_000 })
        item.uiVisibleMs ??= Date.now() - since
        r.note(`/feedback/${item.feedbackId} shows "${item.key}"`)
      }
      writeState({ items })
      await page.screenshot({ path: path.join(SCREENS_DIR, 'admin-dark-s1-06-last-feedback-detail.png'), fullPage: true })
      expect(items.length).toBe(COMMENTS.length)
    })

    await s1Step(page, '07-visible-categories', ['metrics-api'], async (r) => {
      await page.goto(site('/categories?q=Zebrafin'), { waitUntil: 'domcontentloaded' })
      await settle(page, 2_500)
      const missing = await missingOnPage(page)
      r.note(`Categories ?q=Zebrafin: ${COMMENTS.length - missing.length}/${COMMENTS.length} shown; missing: ${missing.join(', ') || 'none'}`)
      expect(missing).toEqual([])
    })

    await s1Step(page, '08-visible-data-explorer', ['metrics-api', 'data-explorer-api'], async (r) => {
      await page.goto(site('/data-explorer'), { waitUntil: 'domcontentloaded' })
      await settle(page, 800)
      await page.getByRole('tab', { name: /Processed Feedback|Feedback/ }).first().click()
      await settle(page, 1_500)
      const source = page.getByLabel('Source')
      if (await source.isVisible().catch(() => false)) {
        const options = await source.locator('option').allInnerTexts()
        r.note(`source options: ${options.slice(0, 20).join(' | ')}`)
        const match = options.find((o) => /manual/i.test(o))
        if (match !== undefined) await source.selectOption({ label: match })
        await settle(page, 1_500)
      }
      await page.getByLabel('Search feedback').fill('Zebrafin')
      await settle(page, 1_500)
      const missing = await missingOnPage(page)
      r.note(`Data Explorer processed feedback, search Zebrafin: ${COMMENTS.length - missing.length}/${COMMENTS.length} shown; missing: ${missing.join(', ') || 'none'}`)
      expect(missing).toEqual([])
    })
  })
})
