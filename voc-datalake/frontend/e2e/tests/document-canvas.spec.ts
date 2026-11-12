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
 * 12. Widths 360 / 390 / 768 / 1024 / 1440: no sideways scroll; on a phone the dirty Save stays on screen, uncovered by
 *     the assistant launcher, and the outline is a "Contents" disclosure.
 *
 * MOCK ONLY for now: the viewer step needs the mock's read-only project, and the rest has not been run on a
 * deployment yet. Mock run (from voc-datalake/frontend, mock + vite on your own ports, README "Local dev mock"):
 *   PORT=3417 node mock-server.js &   VITE_API_ENDPOINT=http://localhost:3417 npx vite --port 5417 --strictPort &
 *   cd e2e && E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/document-canvas.spec.ts
 */
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import {
  CANVAS_TEXT, DOCUMENT_PUT, actionsBar, barButton, canvasOf, caretAtEnd, clickSave, createDocument, documentRow,
  blockTexts, dragBlock, formatBar, openDocument, replaceCanvasText, saveStatus, savedAt, selectInCanvas, storedDocument,
} from '../lib/canvas'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, RUN_PREFIX, SCREENS_DIR } from '../lib/env'
import { expectRefusal } from '../lib/expectedRefusal'
import { assertStep, isApi, roleOf } from '../lib/fixtures'
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

/** No sideways scroll: the page is never wider than the window. */
async function expectNoSidewaysScroll(page: Page, label: string): Promise<void> {
  const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
  expect(scrollWidth, `${label}: scrollWidth ${scrollWidth} <= innerWidth ${innerWidth}`).toBeLessThanOrEqual(innerWidth)
}

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
      await barButton(page, 'Share for review').click()
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
      await expect(barButton(page, 'Share for review'), 'no active link: the bar says Share for review').toBeVisible()
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
      await barButton(page, 'History').click()
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
      await barButton(page, 'History').click()
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
      for (const name of ['Save', 'Discard', 'Delete document', 'Share for review']) await expect(barButton(page, name)).toHaveCount(0)
      await expect(barButton(page, 'History')).toBeVisible()
      await expect(barButton(page, 'Download options')).toBeVisible()
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

  for (const width of [360, 390, 768, 1024, 1440]) {
    test(`width ${width}: no sideways scroll; the save and the outline stay in reach`, async ({ page }) => {
      const title = titled(`width ${width}`)
      await createDocument(PROJECT, { title, content: PRFAQ_BODY, document_type: 'prfaq' })
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
      await assertStep(page, 'admin', `canvas-width-${width}`, async () => {
        const canvas = await openDocument(page, PROJECT, title)
        await expect(page.getByRole('tablist', { name: 'Comments and evidence', exact: true })).toBeVisible()
        await expectNoSidewaysScroll(page, `${width} clean`)
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
        await expectNoSidewaysScroll(page, `${width} dirty`)
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
