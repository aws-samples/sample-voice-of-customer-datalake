/**
 * The document canvas (6.05): Projects › a project › Documents shows each prose document on its page, edited in place
 * (components/DocumentCanvas, docs in the module headers). Each test writes only documents it creates itself
 * (`POST /projects/{id}/documents`, named `e2e-<run id>-canvas …`), so it never depends on the mock's fixtures'
 * content (which other work enriches) and a rerun against the same mock process starts fresh.
 *
 * 1. Edit in place: type, the `## ` shortcut makes a heading, "/" → To-do list inserts a to-do, the format bar's Bold;
 *    "Unsaved changes"; Save → ONE PUT with the loaded `expected_revision`, "Saved · v2"; a reload shows the text.
 * 2. Discard: back to the stored text, nothing sent.
 * 3. Conflict: two pages; A saves, B's stale save gets a 409 and the banner, keeps its draft; "Load the latest" shows A's.
 * 4. Leave guard: another document while dirty asks ("Unsaved changes"): Cancel stays, Discard goes.
 * 5. Comments (a PR/FAQ): select a passage → Comment in the format bar → write → the thread in the margin; reply;
 *    the posted comment closes the format bar; resolve (hidden) → "Show resolved" shows it; open and resolved threads
 *    keep AA contrast (axe) and their author names whole; the Evidence tab.
 * 6. Share (a PR/FAQ): Share for review → create the link → Copy says "Copied" → Turn off link.
 * 7. History: Versions → Restore v1 → confirm → the canvas shows v1's text as v3.
 * 8. Outline: a "Contents" link puts the caret in its heading (editable), focuses the heading (read-only).
 * 9. Viewer (proj_2, the mock's read-only project): no editing, no Save / Discard / Delete, typing changes nothing.
 * 10. Keyboard only: Tab to the canvas (a visible focus ring), type, Ctrl+S saves.
 * 11. Drag a block: hover a block, press on its handle's grip, move and release over another block's end (the
 *     mouse, as a person would): the block moves, "Unsaved changes", Save stores the new order (moved, not copied).
 * 12. Focus view at 1440 and 390 ("Full screen", `?view=focus`): the button, focus in the canvas, the live note, nothing
 *     else of the app on screen (sidebar, header, project tabs, list, launcher), the rail beside the text (1440) or under
 *     it (390), Escape leaves (focus back on the button), Ctrl+Shift+F, a reload keeps it, the button leaves it; it adds
 *     no history entry (after a save in it, Back goes to the page before, never the older version); a draft goes
 *     through it without the leave guard.
 * 13. The File menu: keyboard (Enter opens on Save, arrows wrap, End, Escape back to File, not leaving anything else),
 *     Save with its state (Saved / Unsaved changes) and one PUT, Share opens its dialog; Download as Markdown is the
 *     stored text (an unsaved edit is not in it); the PDF's print document without, then with "Include open comments"
 *     (the quote and the comment), each rendered to a PDF file.
 * 14. Widths 360 / 390 / 768 / 1024 / 1440: no sideways scroll; on a phone the dirty Save stays on screen, uncovered by
 *     the assistant launcher, and the outline is a "Contents" disclosure.
 * 15. Revise from comments (its own describe, by the mock's MOCK_REVISE_OUTCOME): at 1440 and 390, the button is
 *     disabled until a thread is answered; reply and resolve with the mouse (no two bubbles' boxes intersect, the
 *     reply box open or not), Revise → the proposal (focused, two labelled groups, AA);
 *     accept one, Discard (pending again), accept it again from the keyboard (into the draft, "Unsaved changes"),
 *     reject one, Save → v2 and the addressed POST on v2 → the thread says "Addressed in v2", the "Addressed" filter,
 *     "Ask personas to review again". With MOCK_REVISE_OUTCOME=recommendations: the panel, a link to its thread
 *     (focused), nothing written; with =applied: the banner, the canvas on v2, Undo → v3 with the old text and the
 *     thread's mark cleared (Revise offered again), Review again files persona comments; saved over (v3), Undo asks
 *     first (Keep it focused; Undo anyway → v4).
 *
 * MOCK ONLY for now: the viewer step needs the mock's read-only project, and the rest has not been run on a
 * deployment yet. Mock run (from voc-datalake/frontend, mock + vite on your own ports, README "Local dev mock"):
 *   PORT=3417 node mock-server.js &   VITE_API_ENDPOINT=http://localhost:3417 npx vite --port 5417 --strictPort &
 *   cd e2e && E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/document-canvas.spec.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { expectNoSidewaysScrolling } from '../lib/a11y'
import { apiCall, listOf, stringField } from '../lib/api'
import {
  CANVAS_TEXT, DOCUMENT_PUT, REVISE_TEXT, actionsBar, addComment, addressedIn, barButton, revisePanel, canvasOf, caretAtEnd, clickSave, createDocument, documentRow, fileMenu, fileMenuItem,
  blockTexts, dragBlock, formatBar, openDocument, replaceCanvasText, saveStatus, savedAt, selectInCanvas, storedDocument,
} from '../lib/canvas'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, RUN_PREFIX, SCREENS_DIR } from '../lib/env'
import { expectRefusal } from '../lib/expectedRefusal'
import { assertStep, escapeRegExp, isApi, roleOf, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'

/** The mock's editable project and its read-only one (mock-server.js mockProjectSharing: proj_2 is legacy-shaped). */
const PROJECT = 'proj_1'
const VIEWER_PROJECT = 'proj_2'

const STAMP = Date.now()
const titled = (what: string): string => `${RUN_PREFIX}canvas ${what} ${STAMP}`

const BODY = [
  '# Delivery plan',
  '',
  'Customers want honest delivery dates and fewer surprises at the door.',
  '',
  '## Background',
  '',
  'Late parcels drive most of the negative reviews this quarter.',
  '',
  '## Risks',
  '',
  'Carrier webhooks arrive late during peak weeks.',
  '',
].join('\n')

const PRFAQ_BODY = [
  '# PR/FAQ: Honest delivery dates',
  '',
  '## Press Release',
  '',
  'Shoppers now see an honest delivery date before they pay, and hear about a delay the moment it is known.',
  '',
  '## Customer FAQ',
  '',
  'Will I get more notifications? Only when the date changes.',
  '',
].join('\n')

/** Nothing (the floating assistant button, a sticky bar) sits on top of `target`'s centre: a click there reaches it. */
async function expectNotCovered(target: Locator, label: string): Promise<void> {
  const cover = await target.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    if (hit === null || el.contains(hit)) return null
    const named = hit.closest('[aria-label]')
    return named?.getAttribute('aria-label') ?? hit.tagName.toLowerCase()
  })
  expect(cover, `${label} is covered by "${cover ?? ''}"`).toBeNull()
}

/** axe's colour-contrast rule over the comment threads in the margin: AA for every text in them (open and resolved). */
async function expectThreadsContrastAA(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page }).include('aside[aria-label="Comments"] article').withRules(['color-contrast']).analyze()
  const failures = result.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary ?? ''}`))
  expect(failures, `${label}: contrast below AA`).toEqual([])
  expect(result.passes.length + result.incomplete.length, `${label}: the scan saw the threads`).toBeGreaterThan(0)
}

/** Nothing in `container` is cut short with an ellipsis (a truncated name, a clipped time). */
async function expectNothingTruncated(container: Locator, label: string): Promise<void> {
  const cut = await container.evaluate((root) => [root, ...root.querySelectorAll('*')]
    .filter((el) => getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth)
    .map((el) => el.textContent ?? ''))
  expect(cut, `${label}: truncated text`).toEqual([])
}

/** Does the floating assistant launcher's box touch `target`'s box (anywhere, not only at its centre)? */
async function launcherOverlaps(page: Page, target: Locator): Promise<boolean> {
  const launcher = page.getByRole('button', { name: 'Open assistant', exact: true })
  if (await launcher.count() === 0) return false
  const [a, b] = await Promise.all([launcher.boundingBox(), target.boundingBox()])
  if (a === null || b === null) return false
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Every write the page sends to the API from now on. */
function writesOf(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    if (['GET', 'OPTIONS', 'HEAD'].includes(request.method())) return
    if (/\/chat\//.test(request.url())) return
    if (isApi(request, request.method(), /\/projects\//)) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  return writes
}

/** The comments margin (components.json documentComments.margin). */
const margin = (page: Page): Locator => page.getByRole('complementary', { name: 'Comments', exact: true })

/** Is `locator` on screen: present, with a box that meets the window (an off-canvas drawer does not)? */
async function onScreen(page: Page, locator: Locator): Promise<boolean> {
  if (await locator.count() === 0) return false
  const box = await locator.first().boundingBox()
  const width = page.viewportSize()?.width ?? 0
  return box !== null && box.width > 0 && box.height > 0 && box.x < width && box.x + box.width > 0
}

/** What of the app shows around the document page: the sidebar, the header, the project's tabs, the list, the launcher. */
async function chromeShown(page: Page, title: string): Promise<Record<string, boolean>> {
  return {
    sidebar: await onScreen(page, page.getByRole('navigation', { name: 'Main', exact: true })),
    header: await onScreen(page, page.getByTestId('header-title')),
    tabs: await onScreen(page, page.getByRole('tablist', { name: 'Project sections', exact: true })),
    list: await onScreen(page, documentRow(page, title)),
    launcher: await onScreen(page, page.getByRole('button', { name: 'Open assistant', exact: true })),
  }
}

/** The focus view's page is the window: edge to edge, and what sits at the window's top corners is the page. */
async function expectPageIsTheWindow(page: Page): Promise<void> {
  const fills = await page.getByTestId('document-detail-pane').evaluate((pane) => {
    const box = pane.getBoundingClientRect()
    const corners = [[4, 4], [window.innerWidth - 4, 4]].map(([x = 0, y = 0]) => pane.contains(document.elementFromPoint(x, y)))
    return { left: Math.round(box.left), width: Math.round(box.width) === document.documentElement.clientWidth, corners }
  })
  expect(fills).toStrictEqual({ left: 0, width: true, corners: [true, true] })
}

/** From now on, keep every print document the PDF export builds (a hidden srcdoc frame it removes after printing). */
async function capturePrintDocuments(page: Page): Promise<void> {
  await page.evaluate(() => {
    const printed: string[] = []
    Reflect.set(window, '__canvasPrintDocs', printed)
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof HTMLIFrameElement && node.srcdoc !== '') printed.push(node.srcdoc)
        }
      }
    }).observe(document.body, { childList: true })
  })
}

/** The `n`th print document built since capturePrintDocuments (1-based), once it exists. */
async function nextPrintDocument(page: Page, n: number): Promise<string> {
  const count = () => page.evaluate(() => {
    const printed: unknown = Reflect.get(window, '__canvasPrintDocs')
    return Array.isArray(printed) ? printed.length : 0
  })
  await expect.poll(count, { timeout: 10_000 }).toBeGreaterThanOrEqual(n)
  return page.evaluate((index) => {
    const printed: unknown = Reflect.get(window, '__canvasPrintDocs')
    return Array.isArray(printed) ? String(printed[index] ?? '') : ''
  }, n - 1)
}

test.describe('document canvas', () => {
  test.skip(!MOCK, 'dev mock only for now: needs the mock read-only project; not yet run on a deployment')
  test.beforeEach(({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'the mock has one user, an admin')
  })
  // The mock process outlives the run: delete every document this run made (a PR/FAQ save is a new row of its series).
  test.afterAll(async () => {
    const project = await apiCall('admin', 'GET', `/projects/${PROJECT}`)
    const own = listOf(project.body, 'documents').filter((d) => (stringField(d, 'title') ?? '').startsWith(`${RUN_PREFIX}canvas `))
    for (const doc of own) {
      const id = encodeURIComponent(stringField(doc, 'document_id') ?? '')
      await apiCall('admin', 'DELETE', `/projects/${PROJECT}/documents/${id}`)
    }
  })

  test('edit in place: shortcut heading, "/" to-do, Bold, Save as a new version, kept after a reload', async ({ page }) => {
    const title = titled('edit')
    const documentId = await createDocument(PROJECT, { title, content: BODY })
    await assertStep(page, 'admin', 'canvas-edit', async (r) => {
      const canvas = await openDocument(page, PROJECT, title)
      await expect(saveStatus(page)).toHaveText(savedAt(1))
      await expect(barButton(page, 'Save')).toBeDisabled()

      await caretAtEnd(canvas)
      await page.keyboard.press('Enter')
      await page.keyboard.type('## Next steps')
      await expect(canvas.getByRole('heading', { name: 'Next steps', level: 2 }), '`## ` makes a heading').toBeVisible()
      await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
      await page.keyboard.press('Enter')
      await page.keyboard.type('/todo')
      const blocks = page.getByRole('listbox', { name: 'Blocks', exact: true })
      await expect(blocks).toBeVisible()
      await expect(canvas, 'the editor keeps focus and points at the option').toHaveAttribute('aria-expanded', 'true')
      await expect(blocks.getByRole('option', { name: 'To-do list' })).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Enter')
      await expect(blocks).toHaveCount(0)
      await page.keyboard.type('Call the carrier about webhooks')
      await expect(canvas.getByRole('checkbox')).toHaveCount(1)

      await selectInCanvas(canvas, 'honest delivery dates')
      await expect(formatBar(page)).toBeVisible()
      await formatBar(page).getByRole('button', { name: 'Bold', exact: true }).click()
      await expect(canvas.locator('strong', { hasText: 'honest delivery dates' })).toBeVisible()
      await expect(formatBar(page).getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true')

      const puts: string[] = []
      page.on('request', (request) => { if (isApi(request, 'PUT', DOCUMENT_PUT)) puts.push(request.postData() ?? '') })
      const res = await clickSave(page)
      expect(res.status()).toBe(200)
      await expect(saveStatus(page)).toHaveText(savedAt(2))
      await expect(barButton(page, 'Save')).toBeDisabled()
      expect(puts, 'one save is one PUT').toHaveLength(1)
      const sent: unknown = JSON.parse(puts[0] ?? '{}')
      expect(isRecord(sent) ? sent['expected_revision'] : undefined, 'the save carries the revision it loaded').toBe(1)
      const content = isRecord(sent) && typeof sent['content'] === 'string' ? sent['content'] : ''
      r.note(`saved content:\n${content}`)
      expect(content).toContain('## Next steps')
      expect(content).toMatch(/- \[ \] Call the carrier about webhooks/)
      expect(content).toContain('**honest delivery dates**')
      expect(content, 'the untouched text is kept as it was').toContain('## Risks\n\nCarrier webhooks arrive late during peak weeks.')

      const stored = await storedDocument(PROJECT, documentId)
      expect(stringField(stored, 'content')).toBe(content)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await documentRow(page, title).click()
      const reloaded = canvasOf(page, title)
      await expect(reloaded.getByRole('heading', { name: 'Next steps', level: 2 })).toBeVisible()
      await expect(reloaded.locator('strong', { hasText: 'honest delivery dates' })).toBeVisible()
      await expect(reloaded).toContainText('Call the carrier about webhooks')
      await expect(saveStatus(page)).toHaveText(savedAt(2))
    })
  })

  test('discard: back to the stored text, nothing sent', async ({ page }) => {
    const title = titled('discard')
    await createDocument(PROJECT, { title, content: BODY })
    await assertStep(page, 'admin', 'canvas-discard', async () => {
      const canvas = await openDocument(page, PROJECT, title)
      const writes = writesOf(page)
      await caretAtEnd(canvas)
      await page.keyboard.type(' A sentence to throw away.')
      await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
      await expect(barButton(page, 'Discard')).toBeEnabled()
      await barButton(page, 'Discard').click()
      await expect(canvas).not.toContainText('A sentence to throw away.')
      await expect(canvas).toContainText('Carrier webhooks arrive late during peak weeks.')
      await expect(saveStatus(page)).toHaveText(savedAt(1))
      await expect(barButton(page, 'Discard')).toBeDisabled()
      expect(writes, 'Discard sends nothing').toEqual([])
    })
  })

  test('conflict: the second page\'s stale save gets the banner, keeps its draft, and loads the latest', async ({ page, context }) => {
    const title = titled('conflict')
    const documentId = await createDocument(PROJECT, { title, content: BODY })
    const pageB = await context.newPage()
    await assertStep(page, 'admin', 'canvas-conflict', async (r) => {
      const canvasA = await openDocument(page, PROJECT, title)
      const canvasB = await openDocument(pageB, PROJECT, title)
      const textA = `${RUN_PREFIX} saved in page A`
      const textB = `${RUN_PREFIX} saved in page B`
      await replaceCanvasText(page, canvasA, textA)
      expect((await clickSave(page)).status()).toBe(200)
      await expect(saveStatus(page)).toHaveText(savedAt(2))

      await replaceCanvasText(pageB, canvasB, textB)
      const stale = await expectRefusal(pageB, { method: 'PUT', path: DOCUMENT_PUT }, [409], () => clickSave(pageB))
      r.note(`stale save -> ${stale.status()}`)
      expect(stale.status(), 'the stale save is refused').toBe(409)
      const banner = pageB.getByRole('alert').filter({ hasText: CANVAS_TEXT.conflict })
      await expect(banner).toBeVisible()
      await expect(banner.getByRole('button', { name: CANVAS_TEXT.saveAnyway })).toBeVisible()
      await expect(canvasB, 'page B keeps its draft').toHaveText(textB)
      await expect(saveStatus(pageB)).toHaveText(CANVAS_TEXT.unsaved)

      const versions = await apiCall('admin', 'GET', `/projects/${PROJECT}/documents/${encodeURIComponent(documentId)}/versions`)
      const contents = listOf(versions.body, 'versions').map((v) => stringField(v, 'content') ?? '')
      expect(contents[0]?.trim(), 'page A\'s save is what the server holds').toBe(textA)
      expect(contents.join('\n'), 'page B\'s stale save made no version').not.toContain(textB)

      await banner.getByRole('button', { name: CANVAS_TEXT.loadLatest }).click()
      await expect(banner).toHaveCount(0)
      await expect(canvasB).toHaveText(textA)
      await expect(saveStatus(pageB)).toHaveText(savedAt(2))
    })
    await pageB.close()
  })

  test('leave guard: another document while dirty asks first', async ({ page }) => {
    const title = titled('guard')
    const other = titled('guard other')
    await createDocument(PROJECT, { title, content: BODY })
    await createDocument(PROJECT, { title: other, content: '# Another document\n\nNothing to see.\n' })
    await assertStep(page, 'admin', 'canvas-leave-guard', async () => {
      const canvas = await openDocument(page, PROJECT, title)
      const writes = writesOf(page)
      await caretAtEnd(canvas)
      await page.keyboard.type(' Not saved yet.')
      await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)

      await documentRow(page, other).click()
      const guard = dialogNamed(page, CANVAS_TEXT.guard)
      await expect(guard).toBeVisible()
      for (const name of ['Save', 'Discard', 'Cancel']) await expect(guard.getByRole('button', { name, exact: true })).toBeVisible()
      await guard.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(guard).toHaveCount(0)
      await expect(canvas, 'Cancel stays with the edit').toContainText('Not saved yet.')

      await documentRow(page, other).click()
      await guard.getByRole('button', { name: 'Discard', exact: true }).click()
      await expect(canvasOf(page, other)).toBeVisible()
      await expect(canvasOf(page, other)).toContainText('Nothing to see.')
      expect(writes, 'Cancel and Discard send nothing').toEqual([])
    })
  })

  test('comments: comment on a passage from the format bar, reply, resolve, show resolved', async ({ page }) => {
    const title = titled('comments')
    await createDocument(PROJECT, { title, content: PRFAQ_BODY, document_type: 'prfaq' })
    await assertStep(page, 'admin', 'canvas-comments', async () => {
      const canvas = await openDocument(page, PROJECT, title)
      const tabs = page.getByRole('tablist', { name: 'Comments and evidence', exact: true })
      await expect(tabs.getByRole('tab', { name: 'Comments', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(margin(page).getByText('0 open comments')).toBeVisible()

      const passage = 'an honest delivery date before they pay'
      await selectInCanvas(canvas, passage)
      await expect(formatBar(page)).toBeVisible()
      await formatBar(page).getByRole('button', { name: 'Comment', exact: true }).click()
      const composer = margin(page).getByRole('textbox', { name: 'Add a comment', exact: true })
      await expect(composer).toBeFocused()
      await expect(margin(page).locator('blockquote', { hasText: passage })).toBeVisible()
      const comment = `${RUN_PREFIX} is the date shown on the product page too?`
      await composer.fill(comment)
      const created = page.waitForResponse((res) => isApi(res, 'POST', /\/documents\/[^/]+\/comments$/))
      await margin(page).getByRole('button', { name: 'Comment', exact: true }).click()
      expect((await created).status()).toBeLessThan(300)

      const thread = margin(page).getByRole('article').filter({ hasText: comment })
      await expect(thread).toBeVisible()
      await expect(thread.locator('blockquote')).toHaveText(passage)
      await expect(margin(page).getByText('1 open comment', { exact: true })).toBeVisible()
      await expect(formatBar(page), 'the posted comment consumed the selection: the format bar closes').toBeHidden()
      await expectNothingTruncated(thread, 'open thread')
      await expectThreadsContrastAA(page, 'open thread')

      await thread.getByRole('button', { name: 'Reply', exact: true }).click()
      const reply = `${RUN_PREFIX} yes, from the same estimate`
      await thread.getByRole('textbox', { name: 'Write a reply', exact: true }).fill(reply)
      await thread.getByRole('button', { name: 'Reply', exact: true }).click()
      await expect(thread.getByText(reply)).toBeVisible()

      await thread.getByRole('button', { name: 'Resolve', exact: true }).click()
      await expect(thread, 'a resolved thread is hidden by default').toHaveCount(0)
      await expect(margin(page).getByText('0 open comments')).toBeVisible()
      await margin(page).getByRole('checkbox', { name: 'Show resolved' }).check()
      await expect(thread).toBeVisible()
      await expect(thread.getByText('Resolved', { exact: true })).toBeVisible()
      await expect(thread.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible()
      await expectNothingTruncated(thread, 'resolved thread')
      await expectThreadsContrastAA(page, 'resolved thread')

      await tabs.getByRole('tab', { name: 'Evidence', exact: true }).click()
      await expect(tabs.getByRole('tab', { name: 'Evidence', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(margin(page)).toBeHidden()
      await tabs.getByRole('tab', { name: 'Evidence', exact: true }).press('ArrowLeft')
      await expect(tabs.getByRole('tab', { name: 'Comments', exact: true })).toBeFocused()
      await expect(margin(page)).toBeVisible()
    })
  })

  test('share: create a review link, copy it, turn it off', async ({ page, context }) => {
    const title = titled('share')
    await createDocument(PROJECT, { title, content: PRFAQ_BODY, document_type: 'prfaq' })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await assertStep(page, 'admin', 'canvas-share', async (r) => {
      await openDocument(page, PROJECT, title)
      await (await fileMenuItem(page, 'Share for review')).click()
      const share = dialogNamed(page, 'Share for review')
      await expect(share).toBeVisible()
      await share.getByRole('button', { name: 'Create review link', exact: true }).click()
      const link = share.getByRole('textbox', { name: 'Review link', exact: true })
      await expect(link).toHaveValue(/\/review\//)
      r.note(`review link: ${await link.inputValue()}`)
      await share.getByRole('button', { name: 'Copy', exact: true }).click()
      await expect(share.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await link.inputValue())
      await share.getByRole('button', { name: 'Turn off link', exact: true }).click()
      await expect(share.getByRole('button', { name: 'Create review link', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(share).toHaveCount(0)
      await expect(await fileMenuItem(page, 'Share for review'), 'no active link: the menu says Share for review').toBeVisible()
      await page.keyboard.press('Escape')
      await expect(fileMenu(page)).toHaveCount(0)
    })
  })

  test('history: restore v1 from Versions, the canvas shows it as a new version', async ({ page }) => {
    const title = titled('history')
    const documentId = await createDocument(PROJECT, { title, content: BODY })
    const edited = `${BODY}\nAn edit saved as v2.\n`
    const put = await apiCall('admin', 'PUT', `/projects/${PROJECT}/documents/${encodeURIComponent(documentId)}`, { content: edited, expected_revision: 1 })
    expect(put.status, 'PUT v2').toBe(200)
    await assertStep(page, 'admin', 'canvas-history', async () => {
      const canvas = await openDocument(page, PROJECT, title)
      await expect(canvas).toContainText('An edit saved as v2.')
      await expect(saveStatus(page)).toHaveText(savedAt(2))
      await (await fileMenuItem(page, 'History')).click()
      const versions = dialogNamed(page, 'Versions')
      await expect(versions).toBeVisible()
      await expect(versions.getByRole('button', { name: 'Open v2', exact: true })).toBeVisible()
      await versions.getByRole('button', { name: 'Restore v1', exact: true }).click()
      const confirm = dialogNamed(page, 'Restore this version?')
      const restored = page.waitForResponse((res) => isApi(res, 'POST', /\/versions\/[^/]+\/restore$/))
      await confirm.getByRole('button', { name: 'Restore', exact: true }).click()
      expect((await restored).status()).toBeLessThan(300)
      await expect(versions, 'the restore closes History').toHaveCount(0)
      await expect(canvas).not.toContainText('An edit saved as v2.')
      await expect(canvas).toContainText('Carrier webhooks arrive late during peak weeks.')
      await expect(saveStatus(page)).toHaveText(savedAt(3))
      await (await fileMenuItem(page, 'History')).click()
      await expect(versions.getByText('Restored from v1', { exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(versions).toHaveCount(0)
    })
  })

  test('outline: a Contents link puts the caret in its heading', async ({ page }) => {
    const title = titled('outline')
    await createDocument(PROJECT, { title, content: BODY })
    await assertStep(page, 'admin', 'canvas-outline', async () => {
      const canvas = await openDocument(page, PROJECT, title)
      const contents = page.getByRole('navigation', { name: 'Contents', exact: true })
      await expect(contents.getByRole('link')).toHaveText(['Delivery plan', 'Background', 'Risks'])
      const risks = contents.getByRole('link', { name: 'Risks', exact: true })
      const id = ((await risks.getAttribute('href')) ?? '').replace(/^#/, '')
      expect(id).not.toBe('')
      await expect(canvas.locator(`[id="${id}"]`)).toHaveText('Risks')
      await risks.click()
      await expect(canvas).toBeFocused()
      await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('h1, h2, h3, h4')?.id ?? '')).toBe(id)
      await expect(risks).toHaveAttribute('aria-current', 'location')
    })
  })

  test('viewer: a read-only canvas, no save or delete, the outline focuses the heading', async ({ page }) => {
    const project = await apiCall('admin', 'GET', `/projects/${VIEWER_PROJECT}`)
    const doc = listOf(project.body, 'documents').find((d) => d['document_type'] === 'research' || d['document_type'] === 'custom')
    const title = stringField(doc, 'title') ?? ''
    test.skip(title === '', `${VIEWER_PROJECT} has no research or custom document`)
    await assertStep(page, 'admin', 'canvas-viewer', async () => {
      const canvas = await openDocument(page, VIEWER_PROJECT, title)
      await expect(canvas).toHaveAttribute('contenteditable', 'false')
      for (const name of ['Save', 'Discard']) await expect(barButton(page, name)).toHaveCount(0)
      await expect(await fileMenuItem(page, 'History')).toBeVisible()
      await expect(await fileMenuItem(page, 'Download as Markdown')).toBeVisible()
      for (const name of ['Save', 'Delete document', 'Share for review']) await expect(await fileMenuItem(page, name)).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('textbox', { name: 'Document title' }), 'the title is not editable').toHaveCount(0)
      const before = (await canvas.textContent()) ?? ''
      await canvas.click()
      await page.keyboard.type('typed by a viewer')
      await expect(canvas).not.toContainText('typed by a viewer')
      expect(await canvas.textContent()).toBe(before)
      await expect(saveStatus(page)).not.toHaveText(CANVAS_TEXT.unsaved)
      const heading = canvas.getByRole('heading').nth(1)
      const name = (await heading.innerText()).trim()
      await page.getByRole('navigation', { name: 'Contents', exact: true }).getByRole('link', { name, exact: true }).click()
      await expect(heading).toBeFocused()
    })
  })

  test('keyboard only: Tab to the canvas, type, Ctrl+S saves', async ({ page }) => {
    const title = titled('keyboard')
    const documentId = await createDocument(PROJECT, { title, content: BODY })
    await assertStep(page, 'admin', 'canvas-keyboard', async () => {
      const canvas = await openDocument(page, PROJECT, title)
      // Start from the selected row in the list, as a keyboard user arriving there would.
      await documentRow(page, title).focus()
      let reached = false
      for (let tab = 0; tab < 30 && !reached; tab += 1) {
        await page.keyboard.press('Tab')
        reached = await canvas.evaluate((el) => el === document.activeElement)
      }
      expect(reached, 'Tab reaches the canvas').toBe(true)
      const ring = await canvas.evaluate((el) => {
        const style = getComputedStyle(el)
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
      })
      expect(ring.style, 'the focused canvas shows a focus ring').not.toBe('none')
      expect(ring.width, 'the ring is at least 2px').toBeGreaterThanOrEqual(2)
      await page.keyboard.press('Control+End')
      await page.keyboard.type(' Typed with the keyboard only.')
      await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
      const saved = page.waitForResponse((res) => isApi(res, 'PUT', DOCUMENT_PUT))
      await page.keyboard.press('Control+s')
      expect((await saved).status()).toBe(200)
      await expect(saveStatus(page)).toHaveText(savedAt(2))
      await expect(canvas, 'focus stays in the text after the save').toBeFocused()
      const stored = stringField(await storedDocument(PROJECT, documentId), 'content') ?? ''
      expect(stored.trimEnd(), 'Ctrl+End went to the end of the text').toMatch(/peak weeks\. Typed with the keyboard only\.$/)
    })
  })

  test('drag a block by its handle: the block moves, the page is dirty, Save stores the new order', async ({ page }) => {
    const title = titled('drag')
    const documentId = await createDocument(PROJECT, { title, content: BODY })
    await assertStep(page, 'admin', 'canvas-drag', async () => {
      const canvas = await openDocument(page, PROJECT, title)
      const intro = 'Customers want honest delivery dates and fewer surprises at the door.'
      const last = 'Carrier webhooks arrive late during peak weeks.'
      expect(await blockTexts(canvas)).toEqual(['Delivery plan', intro, 'Background', 'Late parcels drive most of the negative reviews this quarter.', 'Risks', last])

      await dragBlock(page, canvas.getByText(intro, { exact: true }), canvas.getByText(last, { exact: true }))

      await expect.poll(() => blockTexts(canvas), { message: 'the dragged block sits after the last one' })
        .toEqual(['Delivery plan', 'Background', 'Late parcels drive most of the negative reviews this quarter.', 'Risks', last, intro])
      await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
      expect((await clickSave(page)).status()).toBe(200)
      await expect(saveStatus(page)).toHaveText(savedAt(2))
      const stored = stringField(await storedDocument(PROJECT, documentId), 'content') ?? ''
      expect(stored.indexOf(intro), 'the stored text has the new order').toBeGreaterThan(stored.indexOf(last))
      expect(stored, 'the moved block was moved, not copied').toContain(`## Risks\n\n${last}\n\n${intro}`)
    })
  })

  for (const width of [1440, 390]) {
    test(`focus view at ${width}: Full screen, Esc, Ctrl+Shift+F, the address, reload, the button; nothing else of the app`, async ({ page }) => {
      const title = titled(`focus ${width}`)
      await createDocument(PROJECT, { title, content: PRFAQ_BODY, document_type: 'prfaq' })
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
      await assertStep(page, 'admin', `canvas-focus-${width}`, async (r) => {
        const canvas = await openDocument(page, PROJECT, title)
        const toggle = barButton(page, 'Full screen')
        await expect(toggle).toHaveAttribute('aria-pressed', 'false')
        expect(await chromeShown(page, title), 'the app around the page').toStrictEqual({ sidebar: width >= 1024, header: true, tabs: true, list: true, launcher: true })

        // The button: in, the page is the window; focus in the canvas; the note says how to leave.
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-pressed', 'true')
        await expect(page).toHaveURL(/[?&]view=focus(&|$)/)
        await expect(canvas).toBeFocused()
        await expect(page.getByTestId('canvas-focus-note')).toHaveText('Full screen. Press Escape to leave.')
        expect(await chromeShown(page, title), 'nothing else of the app').toStrictEqual({ sidebar: false, header: false, tabs: false, list: false, launcher: false })
        await expectPageIsTheWindow(page)
        await expectNoSidewaysScrolling(page, `${width} focus`)
        await expect(margin(page)).toBeVisible()
        const [text, rail] = await Promise.all([canvas.boundingBox(), margin(page).boundingBox()])
        if (text === null || rail === null) throw new Error('no boxes')
        r.note(`canvas ${JSON.stringify(text)} rail ${JSON.stringify(rail)}`)
        if (width >= 1280) expect(rail.x, 'the rail beside the text').toBeGreaterThanOrEqual(text.x + text.width - 1)
        else expect(rail.y, 'one column: the rail under the text').toBeGreaterThanOrEqual(text.y + text.height - 1)
        await page.screenshot({ path: path.join(SCREENS_DIR, `admin-dark-canvas-focus-on-${width}.png`) })

        // Escape leaves; focus back on the button.
        await page.keyboard.press('Escape')
        await expect(toggle).toHaveAttribute('aria-pressed', 'false')
        await expect(toggle).toBeFocused()
        await expect(page).not.toHaveURL(/view=focus/)
        await expect(documentRow(page, title), 'the list is back').toBeAttached()

        // The shortcut toggles it; a reload keeps it; the button leaves it.
        await canvas.focus()
        await page.keyboard.press('Control+Shift+F')
        await expect(toggle).toHaveAttribute('aria-pressed', 'true')
        await page.reload({ waitUntil: 'domcontentloaded' })
        await expect(canvasOf(page, title)).toBeVisible({ timeout: 20_000 })
        await expect(barButton(page, 'Full screen'), 'a reload keeps it').toHaveAttribute('aria-pressed', 'true')
        expect((await chromeShown(page, title)).list).toBe(false)
        await barButton(page, 'Full screen').click()
        await expect(barButton(page, 'Full screen')).toHaveAttribute('aria-pressed', 'false')
        await expect(page).not.toHaveURL(/view=focus/)
        await expect(documentRow(page, title)).toBeVisible()
        await expect(canvasOf(page, title)).toBeVisible()
      })
    })
  }

  test('focus view adds no history entry: after a save in it, Back goes to the page before, never the older version', async ({ page }) => {
    const title = titled('focus back')
    const firstId = await createDocument(PROJECT, { title, content: PRFAQ_BODY, document_type: 'prfaq' })
    await assertStep(page, 'admin', 'canvas-focus-back', async () => {
      // The page before the document's: the project's overview.
      await page.goto(site(`/projects/${encodeURIComponent(PROJECT)}`), { waitUntil: 'domcontentloaded' })
      const canvas = await openDocument(page, PROJECT, title)
      await expect(page).toHaveURL(new RegExp(`[?&]doc=${escapeRegExp(firstId)}(&|$)`))
      await barButton(page, 'Full screen').click()
      await expect(page).toHaveURL(/[?&]view=focus(&|$)/)

      await caretAtEnd(canvas)
      await page.keyboard.type(' Saved in full screen.')
      expect((await clickSave(page)).status()).toBe(200)
      await expect(saveStatus(page)).toHaveText(savedAt(2))
      await expect(page, 'the saved version selected').not.toHaveURL(new RegExp(`[?&]doc=${escapeRegExp(firstId)}(&|$)`))

      await page.goBack({ waitUntil: 'domcontentloaded' })
      await expect(page, 'Back left the document page').not.toHaveURL(/[?&]doc=/)
      await expect(page).not.toHaveURL(new RegExp(escapeRegExp(firstId)))
      await expect(page).toHaveURL(new RegExp(`/projects/${escapeRegExp(PROJECT)}`))
    })
  })

  test('focus view keeps a draft: entering and leaving with unsaved changes asks nothing and loses nothing', async ({ page }) => {
    const title = titled('focus draft')
    await createDocument(PROJECT, { title, content: BODY })
    await assertStep(page, 'admin', 'canvas-focus-draft', async () => {
      const canvas = await openDocument(page, PROJECT, title)
      await caretAtEnd(canvas)
      await page.keyboard.type(' Kept through full screen.')
      await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
      await barButton(page, 'Full screen').click()
      await expect(barButton(page, 'Full screen')).toHaveAttribute('aria-pressed', 'true')
      await expect(dialogNamed(page, CANVAS_TEXT.guard), 'no leave guard').toHaveCount(0)
      await expect(canvas).toContainText('Kept through full screen.')
      await page.keyboard.press('Escape')
      await expect(barButton(page, 'Full screen')).toHaveAttribute('aria-pressed', 'false')
      await expect(dialogNamed(page, CANVAS_TEXT.guard)).toHaveCount(0)
      await expect(canvas).toContainText('Kept through full screen.')
      await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
      await barButton(page, 'Discard').click()
    })
  })

  test('File menu: the keyboard (open, arrows, Esc), Save and its state, Share opens its dialog', async ({ page }) => {
    const title = titled('menu')
    await createDocument(PROJECT, { title, content: PRFAQ_BODY, document_type: 'prfaq' })
    await assertStep(page, 'admin', 'canvas-menu-keyboard', async () => {
      const canvas = await openDocument(page, PROJECT, title)
      const file = barButton(page, 'File')
      await expect(file).toHaveAttribute('aria-haspopup', 'menu')
      await file.focus()
      await page.keyboard.press('Enter')
      await expect(fileMenu(page)).toBeVisible()
      await expect(file).toHaveAttribute('aria-expanded', 'true')
      const save = fileMenu(page).getByRole('menuitem', { name: 'Save', exact: true })
      await expect(save, 'focus on the first item').toBeFocused()
      await expect(save).toHaveAttribute('aria-disabled', 'true')
      await expect(save).toHaveAccessibleDescription('Saved')
      await page.keyboard.press('ArrowDown')
      await expect(fileMenu(page).getByRole('menuitem', { name: 'Share for review', exact: true })).toBeFocused()
      await page.keyboard.press('End')
      await expect(fileMenu(page).getByRole('menuitem', { name: 'Delete document', exact: true })).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(save, 'the arrows wrap').toBeFocused()
      await page.keyboard.press('Escape')
      await expect(fileMenu(page)).toHaveCount(0)
      await expect(file).toBeFocused()
      await expect(barButton(page, 'Full screen'), 'Escape in the menu is the menu\'s').toHaveAttribute('aria-pressed', 'false')

      // Save from the menu: its state, one PUT, back to "Saved".
      await caretAtEnd(canvas)
      await page.keyboard.type(' Saved from the menu.')
      await expect(await fileMenuItem(page, 'Save')).toHaveAccessibleDescription(CANVAS_TEXT.unsaved)
      await expect(await fileMenuItem(page, 'Save')).toHaveAttribute('aria-disabled', 'false')
      const saved = page.waitForResponse((res) => isApi(res, 'PUT', DOCUMENT_PUT))
      await (await fileMenuItem(page, 'Save')).click()
      expect((await saved).status()).toBe(200)
      await expect(saveStatus(page)).toHaveText(savedAt(2))
      await expect(await fileMenuItem(page, 'Save')).toHaveAccessibleDescription('Saved')
      await page.keyboard.press('Escape')

      // Share opens today's dialog.
      await (await fileMenuItem(page, 'Share for review')).click()
      const share = dialogNamed(page, 'Share for review')
      await expect(share).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(share).toHaveCount(0)
    })
  })

  test('File menu: Download as Markdown is the stored text; the PDF prints with and without the open comments', async ({ page }) => {
    const title = titled('menu export')
    const documentId = await createDocument(PROJECT, { title, content: PRFAQ_BODY, document_type: 'prfaq' })
    const quote = 'an honest delivery date before they pay'
    const comment = `${RUN_PREFIX} which carriers give us the date?`
    const posted = await apiCall('admin', 'POST', `/projects/${PROJECT}/documents/${encodeURIComponent(documentId)}/comments`,
      { text: comment, anchor: { exact: quote, prefix: '', suffix: '', heading: 'Press Release' } })
    expect(posted.status, 'POST comment').toBeLessThan(300)
    await assertStep(page, 'admin', 'canvas-menu-export', async (r) => {
      const canvas = await openDocument(page, PROJECT, title)
      await expect(margin(page).getByRole('article').filter({ hasText: comment })).toBeVisible()
      // An unsaved edit: the downloads still carry the stored version.
      await caretAtEnd(canvas)
      await page.keyboard.type(' Not saved, not exported.')

      const download = page.waitForEvent('download')
      await (await fileMenuItem(page, 'Download as Markdown')).click()
      const file = await download
      const saved = path.join(SCREENS_DIR, '..', `canvas-export-${STAMP}.md`)
      await file.saveAs(saved)
      const stored = stringField(await storedDocument(PROJECT, documentId), 'content') ?? ''
      expect(file.suggestedFilename()).toMatch(/\.md$/)
      expect(fs.readFileSync(saved, 'utf8'), 'the file is the stored text').toBe(stored)
      r.note(`markdown: ${file.suggestedFilename()} ${stored.length} chars`)

      await capturePrintDocuments(page)
      await (await fileMenuItem(page, 'Print or save as PDF')).click()
      const plain = await nextPrintDocument(page, 1)
      expect(plain).toContain('Honest delivery dates')
      expect(plain, 'no comments unless asked').not.toContain(comment)

      const include = await fileMenuItem(page, 'Include open comments')
      await expect(include).toHaveAttribute('aria-checked', 'false')
      await include.click()
      await expect(include).toHaveAttribute('aria-checked', 'true')
      await (await fileMenuItem(page, 'Print or save as PDF')).click()
      const withComments = await nextPrintDocument(page, 2)
      expect(withComments).toContain('Open comments')
      expect(withComments).toContain(quote)
      expect(withComments).toContain(comment)
      expect(withComments).not.toContain('Not saved, not exported.')
      for (const [name, html] of [['plain', plain], ['comments', withComments]] as const) {
        const printPage = await page.context().newPage()
        await printPage.setContent(html, { waitUntil: 'load' })
        const pdfPath = path.join(SCREENS_DIR, '..', `canvas-export-${STAMP}-${name}.pdf`)
        await printPage.pdf({ path: pdfPath, format: 'A4' })
        await printPage.close()
        const size = fs.statSync(pdfPath).size
        r.note(`PDF (${name}): ${size} bytes`)
        expect(size, `the ${name} print document makes a PDF file`).toBeGreaterThan(5_000)
      }
      await barButton(page, 'Discard').click()
    })
  })

  for (const width of [360, 390, 768, 1024, 1440]) {
    test(`width ${width}: no sideways scroll; the save and the outline stay in reach`, async ({ page }) => {
      const title = titled(`width ${width}`)
      await createDocument(PROJECT, { title, content: PRFAQ_BODY, document_type: 'prfaq' })
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
      await assertStep(page, 'admin', `canvas-width-${width}`, async () => {
        const canvas = await openDocument(page, PROJECT, title)
        await expect(page.getByRole('tablist', { name: 'Comments and evidence', exact: true })).toBeVisible()
        await expectNoSidewaysScrolling(page, `${width} clean`)
        const contents = page.getByRole('navigation', { name: 'Contents', exact: true })
        const disclosure = contents.getByRole('button', { name: 'Contents', exact: true })
        if (width < 1024) {
          await expect(disclosure, 'narrow: the outline is a disclosure').toHaveAttribute('aria-expanded', 'false')
          await expect(contents.getByRole('link')).toHaveCount(0)
          await disclosure.click()
          await expect(contents.getByRole('link', { name: 'Customer FAQ', exact: true })).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
        } else {
          await expect(disclosure).toBeHidden()
          await expect(contents.getByRole('link', { name: 'Customer FAQ', exact: true })).toBeVisible()
        }
        await caretAtEnd(canvas)
        await page.keyboard.type(' One more line.')
        await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
        await expect(barButton(page, 'Save'), 'the primary action stays on screen').toBeInViewport()
        await expectNoSidewaysScrolling(page, `${width} dirty`)
        await expect.poll(() => launcherOverlaps(page, barButton(page, 'Save')), `${width}: the assistant launcher keeps clear of Save`).toBe(false)
        await page.screenshot({ path: path.join(SCREENS_DIR, `admin-dark-canvas-width-${width}-dirty.png`) })
        await expectNotCovered(barButton(page, 'Save'), `${width}: Save`)
        await expectNotCovered(barButton(page, 'Discard'), `${width}: Discard`)
        await expect(actionsBar(page)).toBeVisible()
        await barButton(page, 'Discard').click()
        await expect(saveStatus(page)).not.toHaveText(CANVAS_TEXT.unsaved)
      })
    })
  }
})

/**
 * Revise from comments (6.06; docs/document-review.md "Revise from comments"). The outcome is the mock's
 * MOCK_REVISE_OUTCOME (default `proposal`); the launcher passes its environment to the mock and to this run alike, so
 * `MOCK_REVISE_OUTCOME=recommendations` / `=applied` runs those outcomes' tests (and skips the proposal's).
 * Each test files its own threads on a PR/FAQ it creates, quoting passages the mock rewrites (mock-document-review.js
 * REWRITES), so its `before` is verbatim.
 */
const REVISE_OUTCOME = process.env['MOCK_REVISE_OUTCOME'] ?? 'proposal'
const ONCE_A_DAY = 'at most once a day unless it moves again'
const ONCE_A_DAY_AFTER = 'at most once a day per parcel, even if it moves again'
const CONTACTS = 'Delivery contacts per 1,000 orders'
const REVISE_BODY = [
  '# PR/FAQ: Delivery messages',
  '',
  '## Customer FAQ',
  '',
  `How often will you message me? We message ${ONCE_A_DAY}.`,
  '',
  '## Internal FAQ',
  '',
  `${CONTACTS} fell from 42 to 30 in the pilot.`,
  '',
].join('\n')

test.describe('document canvas: revise from comments', () => {
  test.skip(!MOCK, 'dev mock only for now: the outcome is the mock\'s MOCK_REVISE_OUTCOME')
  test.beforeEach(({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'the mock has one user, an admin')
  })
  test.afterAll(async () => {
    const project = await apiCall('admin', 'GET', `/projects/${PROJECT}`)
    const own = listOf(project.body, 'documents').filter((d) => (stringField(d, 'title') ?? '').startsWith(`${RUN_PREFIX}canvas revise`))
    for (const doc of own) await apiCall('admin', 'DELETE', `/projects/${PROJECT}/documents/${encodeURIComponent(stringField(doc, 'document_id') ?? '')}`)
  })

  /** A PR/FAQ with one thread on each passage the mock rewrites; their texts. */
  async function revisable(what: string): Promise<{ title: string; documentId: string; onceThread: string; contactsThread: string }> {
    const title = titled(`revise ${what}`)
    const documentId = await createDocument(PROJECT, { title, content: REVISE_BODY, document_type: 'prfaq' })
    const onceThread = `${RUN_PREFIX} twice about one parcel and I turn messages off`
    const contactsThread = `${RUN_PREFIX} where does the 42 come from?`
    await addComment(PROJECT, documentId, onceThread, ONCE_A_DAY)
    await addComment(PROJECT, documentId, contactsThread, CONTACTS)
    return { title, documentId, onceThread, contactsThread }
  }

  const threadCard = (page: Page, text: string): Locator => margin(page).getByRole('article').filter({ hasText: text })

  /**
   * No two thread bubbles of the rail overlap: from xl up each sits beside its passage, pushed below the one above
   * it by that one's measured height (useCommentLayout), so two nearby passages' cards never cover each other.
   */
  async function expectNoBubbleOverlap(page: Page, label: string): Promise<void> {
    await expect.poll(async () => {
      const boxes = (await Promise.all((await margin(page).getByRole('article').all()).map((card) => card.boundingBox())))
        .filter((box) => box !== null)
      return boxes.flatMap((a, i) => boxes.slice(i + 1).flatMap((b, j) => {
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
        return apart ? [] : [`${i} and ${i + j + 1}`]
      }))
    }, `${label}: overlapping bubbles`).toEqual([])
  }

  /**
   * Replies to the thread holding `text` in the rail, with the mouse: its Reply button is never covered by the
   * bubble of a nearby passage (Playwright's click fails on a covered target), with the reply box open or not.
   */
  async function replyTo(page: Page, text: string, reply: string): Promise<void> {
    const card = threadCard(page, text)
    await expectNoBubbleOverlap(page, 'before the reply')
    await card.getByRole('button', { name: 'Reply', exact: true }).click()
    await card.getByRole('textbox', { name: 'Write a reply', exact: true }).fill(reply)
    await expectNoBubbleOverlap(page, 'the reply box open')
    await card.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(card.getByText(reply)).toBeVisible()
    await expectNoBubbleOverlap(page, 'after the reply')
  }

  for (const width of [1440, 390]) {
    test(`proposal at ${width}: reply, Revise from comments, accept one, reject one, Save: the thread is addressed in v2`, async ({ page }) => {
      test.skip(REVISE_OUTCOME !== 'proposal', 'the mock serves another outcome')
      const { title, onceThread, contactsThread } = await revisable(`proposal ${width}`)
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
      await assertStep(page, 'admin', `canvas-revise-proposal-${width}`, async () => {
        const canvas = await openDocument(page, PROJECT, title)
        const revise = margin(page).getByRole('button', { name: REVISE_TEXT.button, exact: true })
        await expect(revise, 'no thread answered yet').toBeDisabled()
        await expect(margin(page).getByText(REVISE_TEXT.noThreads)).toBeVisible()

        // Answer both threads: a reply, and a resolve.
        await replyTo(page, onceThread, `${RUN_PREFIX} agreed: once a day per parcel`)
        await threadCard(page, contactsThread).getByRole('button', { name: 'Resolve', exact: true }).click()
        await expect(threadCard(page, contactsThread)).toHaveCount(0)
        await expect(revise).toBeEnabled()

        await revise.click()
        const review = revisePanel(page, REVISE_TEXT.proposal)
        await expect(review).toBeVisible({ timeout: 20_000 })
        await expect(review.getByRole('heading', { name: REVISE_TEXT.proposal }), 'the review takes the focus').toBeFocused()
        await expect(review.getByRole('status')).toHaveText('2 changes suggested.')
        const first = review.getByRole('group', { name: 'Change 1', exact: true })
        const second = review.getByRole('group', { name: 'Change 2', exact: true })
        await expect(first.locator('del')).toHaveText(ONCE_A_DAY)
        await expect(first.locator('ins')).toHaveText(ONCE_A_DAY_AFTER)
        await expectNoSidewaysScrolling(page, `${width} proposal`)
        await page.screenshot({ path: path.join(SCREENS_DIR, `admin-dark-canvas-revise-proposal-${width}.png`) })
        const axe = await new AxeBuilder({ page }).include('[data-testid="revise-proposal"]').withRules(['color-contrast']).analyze()
        expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' '))), 'the review keeps AA contrast').toEqual([])

        // Accept the first; Discard takes it out of the draft without a save: pending again, and accepted again
        // (from the keyboard).
        const acceptFirst = first.getByRole('button', { name: 'Accept change 1', exact: true })
        await acceptFirst.click()
        await expect(first).toContainText('Accepted')
        await barButton(page, 'Discard').click()
        await expect(canvas).not.toContainText(ONCE_A_DAY_AFTER)
        await expect(first, 'pending again after Discard').not.toContainText('Accepted')
        await expect(acceptFirst).toBeEnabled()
        await acceptFirst.focus()
        await page.keyboard.press('Enter')
        await expect(first).toContainText('Accepted')
        await expect(canvas).toContainText(ONCE_A_DAY_AFTER)
        await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
        await second.getByRole('button', { name: 'Reject change 2', exact: true }).click()
        await expect(second).toContainText('Rejected')
        await expect(canvas).toContainText(CONTACTS)
        await expect(review.getByRole('status')).toHaveText('Accepted changes are in your draft. Save to make them a new version.')

        // Save: one new version, then the accepted change's thread is marked addressed by it.
        const addressed = page.waitForResponse((res) => isApi(res, 'POST', /\/comments\/addressed$/))
        expect((await clickSave(page)).status()).toBe(200)
        const marked = await addressed
        expect(marked.status()).toBe(200)
        // The path names the saved version (v2); the server takes its number from it.
        expect(marked.request().postDataJSON()).toStrictEqual({ thread_ids: [expect.any(String)], addressed: true })
        await expect(saveStatus(page)).toHaveText(savedAt(2))
        await expect(review.getByRole('status')).toHaveText('Saved: 1 comment is marked as addressed in v2.')
        await expect(threadCard(page, onceThread).getByText(addressedIn(2), { exact: true })).toBeVisible()
        await expect(margin(page).getByRole('button', { name: REVISE_TEXT.reviewAgain, exact: true })).toBeVisible()
        await margin(page).getByRole('checkbox', { name: 'Addressed', exact: true }).check()
        await expect(threadCard(page, onceThread)).toBeVisible()
        await expect(margin(page).getByRole('article')).toHaveCount(1)
        await expectNoSidewaysScrolling(page, `${width} saved`)
        await page.screenshot({ path: path.join(SCREENS_DIR, `admin-dark-canvas-revise-saved-${width}.png`) })
      })
    })
  }

  test('recommendations: one per thread, linked to it; nothing written', async ({ page }) => {
    test.skip(REVISE_OUTCOME !== 'recommendations', 'run with MOCK_REVISE_OUTCOME=recommendations')
    const { title, onceThread } = await revisable('recommendations')
    await assertStep(page, 'admin', 'canvas-revise-recommendations', async () => {
      const writes = writesOf(page)
      await openDocument(page, PROJECT, title)
      await replyTo(page, onceThread, `${RUN_PREFIX} agreed`)
      await margin(page).getByRole('button', { name: REVISE_TEXT.button, exact: true }).click()
      const panel = revisePanel(page, REVISE_TEXT.recommendations)
      await expect(panel).toBeVisible({ timeout: 20_000 })
      await expect(panel.getByRole('status')).toHaveText('1 recommendation. Nothing in the document was changed.')
      await expect(panel).toContainText('recommendations only')
      await panel.getByRole('button', { name: `Show the comment: ${ONCE_A_DAY}`, exact: true }).click()
      await expect(threadCard(page, onceThread)).toBeFocused()
      expect(writes.filter((w) => w.startsWith('PUT ')), 'nothing written').toEqual([])
      await expect(margin(page).getByRole('button', { name: REVISE_TEXT.reviewAgain, exact: true })).toBeVisible()
    })
  })

  test('applied: the next version is written and shown; Undo restores the previous one; Review again asks the personas', async ({ page }) => {
    test.skip(REVISE_OUTCOME !== 'applied', 'run with MOCK_REVISE_OUTCOME=applied')
    const { title, onceThread } = await revisable('applied')
    await assertStep(page, 'admin', 'canvas-revise-applied', async () => {
      await openDocument(page, PROJECT, title)
      // The server's version is titled "<title> (v2)": the canvas is named by whichever version it shows.
      const canvas = page.getByRole('textbox', { name: new RegExp(`^${escapeRegExp(title)}`) })
      await replyTo(page, onceThread, `${RUN_PREFIX} agreed`)
      await margin(page).getByRole('button', { name: REVISE_TEXT.button, exact: true }).click()
      const banner = revisePanel(page, 'Revised from 1 comment as v2')
      await expect(banner).toBeVisible({ timeout: 20_000 })
      await expect(canvas).toContainText(ONCE_A_DAY_AFTER)
      await expect(saveStatus(page)).toHaveText(savedAt(2))
      await expect(threadCard(page, onceThread).getByText(addressedIn(2), { exact: true })).toBeVisible()

      const restored = page.waitForResponse((res) => isApi(res, 'POST', /\/versions\/[^/]+\/restore$/))
      const cleared = page.waitForResponse((res) => isApi(res, 'POST', /\/comments\/addressed$/))
      await banner.getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await restored).status()).toBeLessThan(300)
      // The undone revision answers its thread no more: the mark is cleared, and Revise may take it again.
      const clear = await cleared
      expect(clear.status()).toBe(200)
      expect(clear.request().postDataJSON()).toStrictEqual({ thread_ids: [expect.any(String)], addressed: false })
      await expect(banner.getByRole('status')).toHaveText('Undone: the previous version is restored as a new version.')
      await expect(canvas).toContainText(ONCE_A_DAY)
      await expect(canvas).not.toContainText(ONCE_A_DAY_AFTER)
      await expect(saveStatus(page)).toHaveText(savedAt(3))
      await expect(threadCard(page, onceThread).getByText(addressedIn(2), { exact: true })).toHaveCount(0)
      await expect(margin(page).getByRole('button', { name: REVISE_TEXT.button, exact: true }), 'Revise is offered again').toBeEnabled()

      await banner.getByRole('button', { name: 'Review again', exact: true }).click()
      await expect(margin(page).getByText(/comments? filed/)).toBeVisible({ timeout: 20_000 })
    })
  })

  test('applied, then saved over: Undo says a newer version would be reverted; Keep it, then Undo anyway', async ({ page }) => {
    test.skip(REVISE_OUTCOME !== 'applied', 'run with MOCK_REVISE_OUTCOME=applied')
    const { title, onceThread } = await revisable('applied then saved')
    await assertStep(page, 'admin', 'canvas-revise-applied-newer', async () => {
      await openDocument(page, PROJECT, title)
      const canvas = page.getByRole('textbox', { name: new RegExp(`^${escapeRegExp(title)}`) })
      await replyTo(page, onceThread, `${RUN_PREFIX} agreed`)
      await margin(page).getByRole('button', { name: REVISE_TEXT.button, exact: true }).click()
      const banner = revisePanel(page, 'Revised from 1 comment as v2')
      await expect(banner).toBeVisible({ timeout: 20_000 })
      await expect(saveStatus(page)).toHaveText(savedAt(2))

      // Someone (here: this page) saves v3 on top of the revision.
      await caretAtEnd(canvas)
      await page.keyboard.type(' Saved after the revision.')
      expect((await clickSave(page)).status()).toBe(200)
      await expect(saveStatus(page)).toHaveText(savedAt(3))

      const writes = writesOf(page)
      await banner.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect(banner.getByRole('status')).toContainText('v3 was saved after this revision.')
      await expect(banner.getByRole('button', { name: 'Keep it', exact: true }), 'the safe choice has the focus').toBeFocused()
      expect(writes.filter((w) => w.includes('/restore')), 'nothing restored yet').toEqual([])
      await banner.getByRole('button', { name: 'Keep it', exact: true }).click()
      await expect(banner.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
      await expect(canvas).toContainText('Saved after the revision.')

      await banner.getByRole('button', { name: 'Undo', exact: true }).click()
      const restored = page.waitForResponse((res) => isApi(res, 'POST', /\/versions\/[^/]+\/restore$/))
      await banner.getByRole('button', { name: 'Undo anyway', exact: true }).click()
      expect((await restored).status()).toBeLessThan(300)
      await expect(banner.getByRole('status')).toHaveText('Undone: the previous version is restored as a new version.')
      await expect(saveStatus(page)).toHaveText(savedAt(4))
      await expect(canvas).toContainText(ONCE_A_DAY)
      await expect(canvas).not.toContainText('Saved after the revision.')
    })
  })
})
