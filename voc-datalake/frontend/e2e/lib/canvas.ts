/**
 * The document canvas (Projects › a project › Documents, 6.05): one prose document on its page, edited in place.
 * Every locator comes from the app's own roles and English strings (public/locales/en/projectDetail.json `canvas`,
 * components.json `documentComments`, `reviewShare`, `unsavedChanges`), so a renamed label fails loudly here.
 *
 * - the canvas: a `textbox` named by the document's title (CanvasEditor, contenteditable);
 * - the page's action bar: the group "Document actions" with the save status (`role=status`), Discard, Save, Share for
 *   review, Download options, History, Delete document;
 * - the outline: the navigation "Contents"; the floating format bar: the toolbar "Text formatting"; the "/" menu: the
 *   listbox "Blocks".
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test'
import { apiCall, stringField } from './api'
import { escapeRegExp, isApi, site } from './fixtures'
import { isRecord } from './guards'

/** projectDetail.json canvas.actions.status / documentModal.conflict, components.json unsavedChanges.title. */
export const CANVAS_TEXT = {
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  conflict: 'Someone saved a newer version of this document meanwhile.',
  loadLatest: 'Load the latest',
  saveAnyway: 'Save mine anyway',
  guard: 'Unsaved changes',
} as const

/** `Saved · v<n> · <when>` (canvas.actions.status.saved with documents.versions.label). */
export const savedAt = (version: number): RegExp => new RegExp(`^Saved · v${version} · `)

/** The PUT a canvas save sends (`PUT /projects/{id}/documents/{doc}`). */
export const DOCUMENT_PUT = /\/projects\/[^/]+\/documents\/[^/]+$/

/** The canvas of the document titled `title` (its accessible name is the title). */
export const canvasOf = (page: Page, title: string): Locator => page.getByRole('textbox', { name: title, exact: true })

export const actionsBar = (page: Page): Locator => page.getByRole('group', { name: 'Document actions', exact: true })

export const saveStatus = (page: Page): Locator => actionsBar(page).getByRole('status')

export const barButton = (page: Page, name: string): Locator => actionsBar(page).getByRole('button', { name, exact: true })

export const formatBar = (page: Page): Locator => page.getByRole('toolbar', { name: 'Text formatting', exact: true })

/** The Documents tab's list row of `title` (a button whose name ends with the title). */
export const documentRow = (page: Page, title: string): Locator =>
  page.getByRole('button', { name: new RegExp(`${escapeRegExp(title)}$`) }).first()

export const documentsPath = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}?tab=documents`

/** Opens the Documents tab of `projectId`, selects `title` and waits for its canvas. */
export async function openDocument(page: Page, projectId: string, title: string): Promise<Locator> {
  await page.goto(site(documentsPath(projectId)), { waitUntil: 'domcontentloaded' })
  await documentRow(page, title).click()
  const canvas = canvasOf(page, title)
  await expect(canvas).toBeVisible({ timeout: 20_000 })
  return canvas
}

/** Creates a document through the API (`POST /projects/{id}/documents`) and returns its id. */
export async function createDocument(projectId: string, fields: { title: string; content: string; document_type?: 'prfaq' | 'prd' }): Promise<string> {
  const created = await apiCall('admin', 'POST', `/projects/${encodeURIComponent(projectId)}/documents`, fields)
  // The API answers `{success, document}`; the mock also echoes a top-level `document_id`.
  const body = isRecord(created.body) ? created.body : {}
  const doc = isRecord(body['document']) ? body['document'] : undefined
  const id = stringField(doc, 'document_id') ?? stringField(body, 'document_id') ?? ''
  if (created.status >= 300 || id === '') throw new Error(`POST /projects/${projectId}/documents -> ${created.status}`)
  return id
}

/** The stored document `documentId` of `projectId` (`GET /projects/{id}`), if listed. */
export async function storedDocument(projectId: string, documentId: string): Promise<Record<string, unknown> | undefined> {
  const res = await apiCall('admin', 'GET', `/projects/${encodeURIComponent(projectId)}`)
  const documents = isRecord(res.body) && Array.isArray(res.body['documents']) ? res.body['documents'] : []
  return documents.filter(isRecord).find((d) => d['document_id'] === documentId)
}

/**
 * Puts the caret at the end of the canvas' last text, as a click there would (the editor follows the document's
 * selection; focusing alone leaves the caret at the start).
 */
export async function caretAtEnd(canvas: Locator): Promise<void> {
  await canvas.focus()
  await canvas.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let last: Node | null = null
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) if ((node.textContent ?? '') !== '') last = node
    if (last === null) throw new Error('the canvas has no text')
    const range = document.createRange()
    range.setStart(last, last.textContent?.length ?? 0)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
}

/**
 * Selects the first occurrence of `text` inside the canvas, as a reader's drag would (a DOM range; the editor follows
 * the document's selection). The text must sit inside one text node (one run of the same marks).
 */
export async function selectInCanvas(canvas: Locator, text: string): Promise<void> {
  await canvas.focus()
  await canvas.evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(needle) ?? -1
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    throw new Error(`"${needle}" is not in the canvas`)
  }, text)
}

/** The block handle's grip (canvas.editor.handle.label): it shows beside the block the pointer is over. */
export const blockGrip = (page: Page): Locator =>
  page.getByRole('button', { name: 'Drag to move the block, or click for its menu', exact: true })

/** The text of each top-level block of the canvas, in order. */
export const blockTexts = (canvas: Locator): Promise<string[]> =>
  canvas.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''))

/**
 * Drags the block `from` by its handle and drops it at the end of the block `to`, with the mouse as a person would:
 * hover the block (its grip appears), press on the grip, move in steps, release over the end of the target's text.
 */
export async function dragBlock(page: Page, from: Locator, to: Locator): Promise<void> {
  await from.hover()
  const grip = blockGrip(page)
  await expect(grip).toBeVisible()
  const start = await grip.boundingBox()
  if (start === null) throw new Error('the grip has no box')
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  const target = await to.boundingBox()
  if (target === null) throw new Error('the drop target has no box')
  await page.mouse.move(target.x + target.width - 4, target.y + target.height / 2, { steps: 12 })
  await page.mouse.up()
}

/** Clicks Save in the action bar and returns the PUT's response. */
export async function clickSave(page: Page): Promise<Response> {
  const saved = page.waitForResponse((res) => isApi(res, 'PUT', DOCUMENT_PUT))
  await barButton(page, 'Save').click()
  return saved
}

/** Replaces the canvas text with `text` (select all, type) and waits for "Unsaved changes". */
export async function replaceCanvasText(page: Page, canvas: Locator, text: string): Promise<void> {
  await canvas.focus()
  await canvas.press('Control+a')
  await page.keyboard.type(text)
  await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
}
