/**
 * P3 — the prototype Enlarge overlay (#386 / M38) and tester pins.
 *
 * Enlarge (Prioritization row → "Enlarge"): the overlay is a dialog named after
 * the prototype. Focus INSIDE the prototype's frame after the frame's document
 * was rewritten with `document.open()` (which drops every listener on it — #386):
 * the frame is opaque-origin (sandbox without allow-same-origin, 5.x), Shift+Tab
 * leaves it to the overlay's Close, Enter closes it and focus returns to "Enlarge";
 * Escape from the overlay's own chrome closes it too. Escape from INSIDE the frame,
 * even after the rewrite, closes it as well (the #386 contract, restored in 5.35): the
 * prototype's pin widget forwards it to the host as a message and re-attaches its
 * listener after `document.open()`. The mock prototype carries the real widget, as a
 * built one does; production skips that case for a prototype built before 5.35.
 *
 * Pins (Project → Documents → the prototype → "Tester pins"): the review panel
 * opens and lists the pins (or its empty state); under E2E_MOCK an open pin is
 * resolved and reads "Resolved".
 *
 * Production is READ ONLY here: it uses a prototype that already exists on a
 * project the role can see (no build: that is an LLM job writing into a real
 * project), and skips with a note when there is none; pins are only read.
 * Under E2E_MOCK the prototype is built by the mock's build job on proj_1, and
 * its document is given a same-origin `prototype_url` (the mock has no CDN), so
 * the frame is the real URL-loaded, same-origin kind #386 is about.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Frame, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { MOCK, apiUrl, siteUrl, type Role } from '../lib/env'
import { isRecord } from '../lib/guards'
import { dialogNamed } from '../lib/dialogs'
import { roleOf, settle, site } from '../lib/fixtures'

interface Prototype { projectId: string; documentId: string; title: string }

const MOCK_PROJECT = 'proj_1'
const MOCK_PROTOTYPE_PATH = '/e2e-prototype.html'
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** The real pin widget, injected the way shared/prototype_pins.py inject_pin_widget does at build time. */
const PIN_WIDGET = fs.readFileSync(path.resolve(HERE, '../../../lambda/shared/static/prototype-pin-widget.js'), 'utf8')
const MOCK_PROTOTYPE_HTML = '<!doctype html><html><body><h1>e2e prototype</h1><button id="cta">Start</button>' +
  `<script>\n${PIN_WIDGET}\nwindow.VoCPinWidget && window.VoCPinWidget.init({"formId": "pf_0123456789abcdef"});\n</script></body></html>`
/** At most this many projects are read looking for an existing prototype (production). */
const MAX_PROJECTS_SCANNED = 15
/** The mock job completes on its second read; a few more reads is the margin. */
const MAX_JOB_POLLS = 5
/** Rows expanded looking for one that shows a prototype. */
const MAX_ROWS_EXPANDED = 10

const documentsOf = (body: unknown): Array<Record<string, unknown>> => listOf(body, 'documents')

/** Mock: build a prototype on proj_1 through the mock's job and return it. */
async function buildMockPrototype(): Promise<Prototype> {
  const started = await apiCall('admin', 'POST', `/projects/${MOCK_PROJECT}/build-prototype`, { title: 'e2e prototype' })
  const jobId = stringField(isRecord(started.body) ? started.body : undefined, 'job_id') ?? ''
  let documentId = ''
  // The mock job advances one step per read: running, then completed.
  for (let poll = 0; poll < MAX_JOB_POLLS && documentId === ''; poll += 1) {
    const job = await apiCall('admin', 'GET', `/projects/${MOCK_PROJECT}/jobs/${jobId}`)
    const record = isRecord(job.body) && isRecord(job.body['job']) ? job.body['job'] : isRecord(job.body) ? job.body : {}
    documentId = stringField(isRecord(record['result']) ? record['result'] : undefined, 'document_id') ?? ''
  }
  if (documentId === '') throw new Error('the mock build-prototype job produced no document')
  const detail = await apiCall('admin', 'GET', `/projects/${MOCK_PROJECT}`)
  const doc = documentsOf(detail.body).find((d) => d['document_id'] === documentId)
  return { projectId: MOCK_PROJECT, documentId, title: stringField(doc, 'title') ?? 'e2e prototype' }
}

/** Production: the first URL-served prototype on a project `role` can see, or null. */
async function findExistingPrototype(role: Role): Promise<Prototype | null> {
  const projects = listOf((await apiCall(role, 'GET', '/projects')).body, 'projects').slice(0, MAX_PROJECTS_SCANNED)
  for (const project of projects) {
    const projectId = stringField(project, 'project_id', 'id')
    if (projectId === undefined) continue
    const detail = await apiCall(role, 'GET', `/projects/${encodeURIComponent(projectId)}`)
    const doc = documentsOf(detail.body).find((d) => d['document_type'] === 'prototype' && typeof d['prototype_url'] === 'string')
    const documentId = stringField(doc, 'document_id')
    if (documentId !== undefined) return { projectId, documentId, title: stringField(doc, 'title') ?? 'Prototype' }
  }
  return null
}

/** `body` (a project read: `{documents}`) with its prototypes given the mock's same-origin URL. */
function withPrototypeUrl(body: unknown): unknown {
  if (!isRecord(body)) return body
  const documents = documentsOf(body).map((d) => (d['document_type'] === 'prototype' ? { ...d, prototype_url: `${siteUrl()}${MOCK_PROTOTYPE_PATH}`, prototype_format: 'html' } : d))
  return { ...body, documents }
}

/**
 * Mock: every read of the project gives its prototypes a same-origin URL, and
 * that URL serves a small page (the mock has no CDN to sign one). Both reads:
 * `GET /projects/{id}` (project page) and Prioritization's batched
 * `GET /projects?ids=` (`{details: [{project, documents}]}`).
 */
async function serveMockPrototypeUrl(page: Page): Promise<void> {
  const api = new URL(apiUrl())
  const isProjectRead = (url: URL) => url.origin === api.origin &&
    (url.pathname === `/projects/${MOCK_PROJECT}` || (url.pathname === '/projects' && url.searchParams.has('ids')))
  await page.route(isProjectRead, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body: unknown = await response.json()
    const details = isRecord(body) && Array.isArray(body['details']) ? body['details'] : undefined
    const json = !isRecord(body) || details === undefined ? withPrototypeUrl(body) : { ...body, details: details.map(withPrototypeUrl) }
    await route.fulfill({ response, json })
  })
  await page.route(`${siteUrl()}${MOCK_PROTOTYPE_PATH}*`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_PROTOTYPE_HTML }))
}

/** The prototype for this run, or skips the test (production without one). */
async function prototypeFor(page: Page, role: Role): Promise<Prototype> {
  if (MOCK) {
    await serveMockPrototypeUrl(page)
    return buildMockPrototype()
  }
  const found = await findExistingPrototype(role)
  test.skip(found === null, 'no URL-served prototype visible to this role (production builds none: read-only)')
  return found ?? { projectId: '', documentId: '', title: '' }
}

/** Expands Prioritization rows one by one until an "Enlarge" control shows; returns it. */
async function enlargeControl(page: Page): Promise<Locator> {
  await page.goto(site('/prioritization'), { waitUntil: 'domcontentloaded' })
  await settle(page, 800)
  const enlarge = page.getByRole('button', { name: 'Enlarge' }).first()
  const rows = page.getByTestId('prioritization-row-toggle').and(page.locator('[aria-expanded="false"]'))
  for (let tries = 0; tries < MAX_ROWS_EXPANDED && !(await enlarge.isVisible()); tries += 1) {
    if ((await rows.count()) === 0) break
    await rows.first().click()
    await settle(page, 400)
  }
  return enlarge
}

/** Clicks Enlarge; the overlay is named after the prototype (ModalShell; "Prototype" when it has no title). */
async function openOverlay(page: Page, enlarge: Locator, title: string): Promise<Locator> {
  await enlarge.click()
  const overlay = dialogNamed(page, title)
  await expect(overlay).toBeVisible()
  return overlay
}

/**
 * What a prototype's own script may do: replace its document with `document.open()`
 * (listeners on the old one are gone, #386); then focus a control inside it.
 */
async function prototypeFrame(overlay: Locator): Promise<Frame> {
  const frame = await (await overlay.locator('iframe').first().elementHandle())?.contentFrame()
  if (frame === null || frame === undefined) throw new Error('the overlay renders the prototype in no frame')
  await frame.waitForLoadState('load')
  return frame
}

/** Whether the prototype's pin widget forwards Escape to the host (built since 5.35). */
async function forwardsEscape(overlay: Locator): Promise<boolean> {
  const frame = await prototypeFrame(overlay)
  return frame.evaluate(() => Reflect.get(Reflect.get(window, 'VoCPinWidget') ?? {}, 'forwardsEscape') === true)
}

async function focusInsideRewrittenFrame(overlay: Locator): Promise<void> {
  const frame = await prototypeFrame(overlay)
  await frame.evaluate(() => {
    document.open()
    document.write('<!doctype html><html><body><button id="after-open">Inside the rewritten prototype</button></body></html>')
    document.close()
  })
  await frame.locator('#after-open').focus()
}

test.describe('prototype overlay and pins', () => {
  test('Enlarge: from inside a rewritten (document.open) frame the overlay is left by keyboard and focus returns (#386)', async ({ page }, testInfo) => {
    const prototype = await prototypeFor(page, roleOf(testInfo))
    const enlarge = await enlargeControl(page)
    test.skip(!(await enlarge.isVisible()), `no prioritization row shows the prototype of ${prototype.projectId}`)

    const overlay = await openOverlay(page, enlarge, prototype.title)
    // 5.x (4b5999df): a URL-served prototype is sandboxed to an OPAQUE origin, so this
    // page cannot hear keys raised inside it; the overlay's visible Close is its exit.
    const sandbox = (await overlay.locator('iframe').first().getAttribute('sandbox')) ?? ''
    expect(sandbox.split(/\s+/), 'the prototype frame runs scripts').toContain('allow-scripts')
    expect(sandbox.split(/\s+/), 'the prototype frame is opaque-origin').not.toContain('allow-same-origin')
    await focusInsideRewrittenFrame(overlay)
    // Shift+Tab leaves the frame to the control before it, the overlay's Close.
    await page.keyboard.press('Shift+Tab')
    const close = overlay.getByRole('button', { name: 'Close', exact: true })
    await expect(close, 'Shift+Tab from inside the frame reaches Close').toBeFocused()
    await page.keyboard.press('Enter')
    await expect(overlay).toHaveCount(0)
    await expect(enlarge, 'focus returns to Enlarge').toBeFocused()

    // And Escape from the overlay's chrome.
    await openOverlay(page, enlarge, prototype.title)
    await close.focus()
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await expect(enlarge, 'focus returns to Enlarge').toBeFocused()
  })

  test('Enlarge: Escape inside a rewritten (document.open) frame closes it and returns focus (#386)', async ({ page }, testInfo) => {
    // The #386 contract. Since 4b5999df the frame is opaque-origin, so ModalShell cannot
    // listen inside it; since 5.35 the pin widget forwards Escape (useFrameEscape) and
    // survives the rewrite. A prototype built earlier has a widget that does not.
    const prototype = await prototypeFor(page, roleOf(testInfo))
    const enlarge = await enlargeControl(page)
    test.skip(!(await enlarge.isVisible()), `no prioritization row shows the prototype of ${prototype.projectId}`)
    const overlay = await openOverlay(page, enlarge, prototype.title)
    const forwards = await forwardsEscape(overlay)
    test.skip(!MOCK && !forwards, 'this prototype was built before 5.35: its pin widget does not forward Escape (rebuild it)')
    expect(forwards, 'the mock prototype carries the current pin widget').toBe(true)
    await focusInsideRewrittenFrame(overlay)
    await page.keyboard.press('Escape')
    await expect(overlay, 'Escape from inside the frame closes the overlay').toHaveCount(0)
    await expect(enlarge, 'focus returns to Enlarge').toBeFocused()
  })

  test('Tester pins: the review panel opens on the prototype and lists its pins', async ({ page }, testInfo) => {
    const prototype = await prototypeFor(page, roleOf(testInfo))
    await page.goto(site(`/projects/${encodeURIComponent(prototype.projectId)}?tab=documents`), { waitUntil: 'domcontentloaded' })
    await settle(page, 800)
    await page.getByRole('button', { name: prototype.title }).first().click()
    const toggle = page.getByRole('button', { name: 'Tester pins' })
    test.skip(!MOCK && !(await toggle.isVisible()), 'pins are reviewed by editors only')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const panel = page.getByRole('complementary', { name: 'Tester pins' })
    await expect(panel.getByRole('heading', { name: /^Tester pins \(\d+\)$/ })).toBeVisible()
    await expect(panel.locator('[data-testid^="pin-"]').first().or(panel.getByText(/No pins yet/))).toBeVisible()
    if (!MOCK) return

    // Mock only (a write): resolve the first open pin.
    const openPin = panel.locator('[data-testid^="pin-"]').filter({ hasText: 'Open' }).first()
    const pinTestId = (await openPin.getAttribute('data-testid')) ?? ''
    await openPin.getByRole('button', { name: 'Resolve' }).click()
    await expect(panel.getByTestId(pinTestId).getByText('Resolved', { exact: true })).toBeVisible()
  })
})
