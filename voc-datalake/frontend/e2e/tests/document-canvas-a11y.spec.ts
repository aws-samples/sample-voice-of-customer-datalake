/**
 * The document page's accessibility and responsive behaviour (Projects › a project › Documents, the document canvas):
 * every state of the page around the editor, at 1440, 1024, 768, 390 and 360 wide, in the dark and the light theme,
 * with reduced motion. Each state passes axe's WCAG 2.2 AA and best-practice rules with no serious or critical finding
 * and keeps to the window (no sideways scroll, lib/a11y.ts). The editor's own menus and popovers ("/", the format bar,
 * the link and image editors, the block menu) are document-canvas.spec.ts's.
 *
 * At every width and theme (what depends on them):
 * 1. Reading a PR/FAQ (the outline or its Contents disclosure, the Comments | Evidence rail, the threads).
 * 2. The File menu opens inside the window (its button keeps the bar's right end on a phone); History and Share for
 *    review; the Evidence tab; a reply box.
 * 3. Full screen opens with the page's header (the save status, Full screen as the way out) on screen.
 * Once, at 360 dark (the keyboard does not change with the width; the File menu's own keys, the tabs' arrows and the
 * viewer's missing controls are document-canvas.spec.ts's):
 * 4. Escape closes History and Share with focus back on File; Escape closes an empty reply box with focus back on
 *    Reply; Ctrl+Enter posts a reply; Revise from comments (the thread now answered) opens a region whose Close shares
 *    its heading's line.
 * 5. The stale-save banner (a research note saved meanwhile through the API) at 1440 and 360, both themes.
 * 6. A viewer's read-only page (the mock's proj_2) at 1440 and 390.
 * 7. On an Android phone at 360 (touch, its user agent), Full screen from the top of a long note: the header stays on
 *    screen and the text takes focus without asking the browser to scroll to it. At 360 (a desktop browser), Full
 *    screen straight from a page read further down: the header (the save status, Full screen) comes on screen.
 *
 * MOCK ONLY, as document-canvas.spec.ts (the viewer needs the mock's read-only project). From voc-datalake/frontend:
 *   PORT=3417 node mock-server.js &   VITE_API_ENDPOINT=http://localhost:3417 npx vite --port 5417 --strictPort &
 *   cd e2e && E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/document-canvas-a11y.spec.ts
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { expectInsideWindow, expectNoSeriousAxe, expectNoSidewaysScrolling } from '../lib/a11y'
import { apiCall, listOf, stringField } from '../lib/api'
import { CANVAS_TEXT, addComment, barButton, canvasOf, createDocument, documentRow, fileMenu, fileMenuItem, saveStatus, storedDocument } from '../lib/canvas'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, RUN_PREFIX } from '../lib/env'
import { pinTheme, roleOf, site, type Theme } from '../lib/fixtures'

const PROJECT = 'proj_1'
const VIEWER_PROJECT = 'proj_2'
const WIDTHS = [1440, 1024, 768, 390, 360] as const
const THEMES: readonly Theme[] = ['dark', 'light']
const STAMP = Date.now()
const PRFAQ = `${RUN_PREFIX}canvas a11y PR/FAQ ${STAMP}`
const NOTE = `${RUN_PREFIX}canvas a11y note ${STAMP}`
/** A note longer than a phone's window: its text runs past the foot of the screen. */
const LONG_NOTE = `${RUN_PREFIX}canvas a11y long note ${STAMP}`
const LONG_NOTE_BODY = ['# Interviews', ...Array.from({ length: 40 }, (_, n) => `Interview ${String(n + 1)}: the delivery date moved twice before the parcel left.`)].join('\n\n')
/** History and Share for review: the File menu's dialogs, by their names. */
const MENU_DIALOGS = [['History', 'Versions'], ['Share for review', 'Share for review']] as const

const PRFAQ_BODY = [
  '# PR/FAQ: Honest delivery dates', '',
  '## Press Release', '',
  'Shoppers now see an honest delivery date before they pay, and hear about a delay the moment it is known.', '',
  '## Customer FAQ', '',
  'Will I get more notifications? Only when the date changes.', '',
].join('\n')

/** The comments rail (components.json documentComments.margin). */
const rail = (page: Page): Locator => page.getByRole('complementary', { name: 'Comments', exact: true })
const replyBox = (page: Page): Locator => rail(page).getByRole('textbox', { name: 'Write a reply', exact: true })

async function atWidth(page: Page, width: number, theme: Theme): Promise<void> {
  await pinTheme(page, theme)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
}

/** Opens `title` in `project`, the page shown from its top (the row's click scrolls the list on a phone). */
async function openPage(page: Page, title: string, project = PROJECT): Promise<void> {
  await page.goto(site(`/projects/${project}?tab=documents`), { waitUntil: 'domcontentloaded' })
  await documentRow(page, title).click()
  await expect(page.getByRole('textbox', { name: title, exact: true })).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('document-detail-pane').evaluate((pane) => { pane.scrollIntoView({ block: 'start' }) })
}

/** The documents of `project` (`GET /projects/{id}`): id, title and type of each. */
async function documentsOf(project: string): Promise<Array<{ id: string; title: string; type: string }>> {
  const { body } = await apiCall('admin', 'GET', `/projects/${project}`)
  return listOf(body, 'documents').map((d) => ({
    id: stringField(d, 'document_id') ?? '', title: stringField(d, 'title') ?? '', type: stringField(d, 'document_type') ?? '',
  }))
}

async function expectStateClean(page: Page, label: string): Promise<void> {
  await expectNoSeriousAxe(page, label)
  await expectNoSidewaysScrolling(page, label)
}

test.describe('document canvas: accessibility and widths', () => {
  test.skip(!MOCK, 'dev mock only, as document-canvas.spec.ts: the viewer needs the mock read-only project')
  test.beforeEach(({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'the mock has one user, an admin')
  })
  test.beforeAll(async () => {
    if (!MOCK) return
    const prfaq = await createDocument(PROJECT, { title: PRFAQ, content: PRFAQ_BODY, document_type: 'prfaq' })
    await addComment(PROJECT, prfaq, 'Which carriers are in the first launch?', 'honest delivery date')
    await addComment(PROJECT, prfaq, 'Add the metric we will watch.', null)
    await createDocument(PROJECT, { title: NOTE, content: '# Notes\n\nA research note about delivery dates.\n' })
    await createDocument(PROJECT, { title: LONG_NOTE, content: LONG_NOTE_BODY })
  })
  // This run's documents only (a PR/FAQ save is a new row of its series, under the same title).
  test.afterAll(async () => {
    if (!MOCK) return
    const ids = (await documentsOf(PROJECT)).filter(({ title }) => [PRFAQ, NOTE, LONG_NOTE].includes(title)).map(({ id }) => id)
    for (const id of ids) await apiCall('admin', 'DELETE', `/projects/${PROJECT}/documents/${encodeURIComponent(id)}`)
  })

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`${width} ${theme}: reading, the File menu and its dialogs, the Evidence tab, a reply box, Full screen`, async ({ page }) => {
        await atWidth(page, width, theme)
        await openPage(page, PRFAQ)
        await expectStateClean(page, 'reading')

        await barButton(page, 'File').click()
        await expectInsideWindow(page, fileMenu(page), 'the File menu')
        await expectStateClean(page, 'the File menu')
        for (const [item, dialog] of MENU_DIALOGS) {
          await (await fileMenuItem(page, item)).click()
          await expect(dialogNamed(page, dialog)).toBeVisible()
          await expectStateClean(page, item)
          await dialogNamed(page, dialog).getByRole('button', { name: 'Dismiss', exact: true }).click()
        }

        await page.getByRole('tab', { name: 'Evidence', exact: true }).click()
        await expectStateClean(page, 'the Evidence tab')
        await page.getByRole('tab', { name: 'Comments', exact: true }).click()
        await rail(page).getByRole('button', { name: 'Reply', exact: true }).first().click()
        await expect(replyBox(page)).toBeFocused()
        await expectStateClean(page, 'a reply box')

        await page.getByTestId('canvas-focus-button').click()
        await expect(page.getByTestId('document-detail-pane')).toHaveAttribute('data-focus-view', '')
        await expect.poll(async () => (await saveStatus(page).boundingBox())?.y ?? -1, { message: 'the header on screen' }).toBeGreaterThanOrEqual(0)
        expect((await page.getByTestId('canvas-focus-button').boundingBox())?.y ?? -1, 'Full screen (the way out) on screen').toBeGreaterThanOrEqual(0)
        await expectStateClean(page, 'Full screen')
      })
    }
  }

  // Full screen straight from a page read further down (nothing else focused first): the chrome steps aside and the
  // app's scroll area, shorter by it, loses some of its scroll; the header (the save status, the way out) still opens
  // on screen.
  test('360: Full screen from a scrolled-down page brings the header on screen', async ({ page }) => {
    await atWidth(page, 360, 'light')
    await openPage(page, LONG_NOTE)
    const scrolled = await page.getByTestId('document-detail-pane').evaluate((pane) => {
      let most = 0
      for (let box = pane.parentElement; box; box = box.parentElement) most = Math.max(most, box.scrollTop)
      return most
    })
    expect(scrolled, 'the app\'s scroll area scrolled down to the page').toBeGreaterThan(0)
    await page.getByTestId('canvas-focus-button').click()
    await expect(page.getByTestId('document-detail-pane')).toHaveAttribute('data-focus-view', '')
    await expect(canvasOf(page, LONG_NOTE)).toBeFocused()
    await expect.poll(async () => (await saveStatus(page).boundingBox())?.y ?? -1, { message: 'the header on screen' }).toBeGreaterThanOrEqual(0)
    await expect(saveStatus(page)).toBeInViewport()
    expect((await page.getByTestId('canvas-focus-button').boundingBox())?.y ?? -1, 'Full screen (the way out) on screen').toBeGreaterThanOrEqual(0)
    await expect(page.getByTestId('canvas-focus-button')).toBeInViewport()
  })

  // A phone's browser (touch, its user agent): there the editor's own focus calls the text's focus() without
  // preventScroll, and a real phone scrolls to the text, past the header. An emulated phone does not scroll on it, so
  // the text's focus calls are read too: every one asks not to scroll.
  test.describe('on an Android phone', () => {
    test.use({ isMobile: true, hasTouch: true, viewport: { width: 360, height: 844 },
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' })
    test('360: Full screen keeps the header on screen', async ({ page }) => {
      await pinTheme(page, 'light')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openPage(page, LONG_NOTE)
      // The page from its top, as it opens: the header on screen, the text running past the foot of the window.
      await page.getByTestId('document-detail-pane').evaluate((pane) => {
        for (let box = pane.parentElement; box; box = box.parentElement) box.scrollTop = 0
      })
      const canvas = canvasOf(page, LONG_NOTE)
      await canvas.evaluate((text) => {
        const calls: unknown[] = []
        Reflect.set(window, '__canvasFocusCalls', calls)
        const own = text.focus.bind(text)
        text.focus = (options?: FocusOptions) => { calls.push(options?.preventScroll === true); own(options) }
      })
      await page.getByTestId('canvas-focus-button').click()
      await expect(page.getByTestId('document-detail-pane')).toHaveAttribute('data-focus-view', '')
      await expect(canvas).toBeFocused()
      expect(await page.evaluate(() => Reflect.get(window, '__canvasFocusCalls')), 'the text\'s focus calls ask not to scroll').toStrictEqual([true])
      await expect.poll(async () => (await saveStatus(page).boundingBox())?.y ?? -1, { message: 'the header on screen' }).toBeGreaterThanOrEqual(0)
      expect((await page.getByTestId('canvas-focus-button').boundingBox())?.y ?? -1, 'Full screen (the way out) on screen').toBeGreaterThanOrEqual(0)
    })
  })

  test('the keyboard: Escape out of History and Share back to File, a reply box\'s Escape and Ctrl+Enter; Revise from comments at 360', async ({ page }) => {
    await atWidth(page, 360, 'dark')
    await openPage(page, PRFAQ)
    const file = barButton(page, 'File')
    for (const [item, dialog] of MENU_DIALOGS) {
      await (await fileMenuItem(page, item)).click()
      await expect(dialogNamed(page, dialog)).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialogNamed(page, dialog)).toHaveCount(0)
      await expect(file, `${item} gives focus back to File`).toBeFocused()
    }

    const thread = rail(page).getByRole('article').filter({ hasText: 'Which carriers are in the first launch?' })
    const reply = thread.getByRole('button', { name: 'Reply', exact: true })
    await reply.click()
    await page.keyboard.press('Escape')
    await expect(replyBox(page)).toHaveCount(0)
    await expect(reply, 'Escape gives focus back to Reply').toBeFocused()
    await reply.click()
    await page.keyboard.type('North and East first.')
    const posted = page.waitForResponse((res) => res.request().method() === 'POST' && /\/replies$/.test(new URL(res.url()).pathname))
    await page.keyboard.press('Control+Enter')
    expect((await posted).status()).toBeLessThan(300)
    await expect(thread.getByText('North and East first.', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Revise from comments', exact: true }).click()
    const outcome = page.getByRole('region', { name: /Suggested changes|Recommendations from the comments|Revised from/ })
    await expect(outcome).toBeVisible({ timeout: 15_000 })
    const [heading, close] = await Promise.all([outcome.getByRole('heading').first().boundingBox(), outcome.getByRole('button', { name: 'Close', exact: true }).boundingBox()])
    expect(heading !== null && close !== null && close.y < heading.y + heading.height, 'Close on the heading\'s line').toBe(true)
    await expectStateClean(page, 'the revise outcome at 360')
  })

  for (const width of [1440, 360] as const) {
    for (const theme of THEMES) {
      test(`${width} ${theme}: the stale-save banner keeps AA and the page in the window`, async ({ page }) => {
        await atWidth(page, width, theme)
        await openPage(page, NOTE)
        await canvasOf(page, NOTE).focus()
        await page.keyboard.press('Control+End')
        await page.keyboard.type(' Mine.')
        await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
        // Someone else saves meanwhile (the API, as another tab would).
        const id = await page.evaluate(() => new URL(window.location.href).searchParams.get('doc') ?? '')
        const stored = await storedDocument(PROJECT, id)
        const theirs = await apiCall('admin', 'PUT', `/projects/${PROJECT}/documents/${encodeURIComponent(id)}`, {
          content: `${stringField(stored, 'content') ?? ''}\nTheirs.\n`, expected_revision: stored?.['revision'], edit_id: `a11y-${Date.now()}`,
        })
        expect(theirs.status).toBeLessThan(300)
        await barButton(page, 'Save').click()
        const banner = page.getByRole('alert').filter({ hasText: CANVAS_TEXT.conflict })
        await expect(banner).toBeVisible()
        await expectStateClean(page, 'the stale-save banner')
        await banner.getByRole('button', { name: CANVAS_TEXT.loadLatest, exact: true }).click()
        await expect(banner).toHaveCount(0)
      })
    }
  }

  for (const width of [1440, 390] as const) {
    test(`${width}: a viewer's read-only page`, async ({ page }) => {
      const prose = (await documentsOf(VIEWER_PROJECT)).find(({ type }) => type === 'research' || type === 'custom')
      const title = prose?.title ?? ''
      test.skip(title === '', `${VIEWER_PROJECT} has no research or custom document`)
      await atWidth(page, width, 'light')
      await openPage(page, title, VIEWER_PROJECT)
      await expectStateClean(page, 'the viewer\'s page')
    })
  }
})
