/**
 * P3 — the prototype Enlarge overlay (#386 / M38) and tester pins.
 *
 * Enlarge (Prioritization row → "Enlarge"): the overlay is a dialog named after
 * the prototype. Focus INSIDE the prototype's frame after the frame's document
 * was rewritten with `document.open()` (which drops every listener on it — the
 * #386 regression) and press Escape: the overlay closes and focus returns to
 * "Enlarge". Escape from the overlay's own chrome closes it too.
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
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { MOCK, apiUrl, siteUrl, type Role } from '../lib/env'
import { isRecord } from '../lib/guards'
import { dialogNamed } from '../lib/dialogs'
import { roleOf, settle, site } from '../lib/fixtures'

interface Prototype { projectId: string; documentId: string; title: string }

const MOCK_PROJECT = 'proj_1'
const MOCK_PROTOTYPE_PATH = '/e2e-prototype.html'
const MOCK_PROTOTYPE_HTML = '<!doctype html><html><body><h1>e2e prototype</h1><button id="cta">Start</button></body></html>'
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

/**
 * Mock: every read of the project gives its prototypes a same-origin URL, and
 * that URL serves a small page (the mock has no CDN to sign one).
 */
async function serveMockPrototypeUrl(page: Page): Promise<void> {
  const api = new URL(apiUrl())
  await page.route((url) => url.origin === api.origin && url.pathname === `/projects/${MOCK_PROJECT}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body: unknown = await response.json()
    const documents = documentsOf(body).map((d) => (d['document_type'] === 'prototype' ? { ...d, prototype_url: `${siteUrl()}${MOCK_PROTOTYPE_PATH}`, prototype_format: 'html' } : d))
    await route.fulfill({ response, json: isRecord(body) ? { ...body, documents } : body })
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
  const rows = page.locator('button[aria-expanded="false"]').filter({ has: page.locator('h3') })
  for (let tries = 0; tries < MAX_ROWS_EXPANDED && !(await enlarge.isVisible()); tries += 1) {
    if ((await rows.count()) === 0) break
    await rows.first().click()
    await settle(page, 400)
  }
  return enlarge
}

test.describe('prototype overlay and pins', () => {
  test('Enlarge: Escape inside a rewritten (document.open) frame closes it and returns focus (#386)', async ({ page }, testInfo) => {
    const prototype = await prototypeFor(page, roleOf(testInfo))
    const enlarge = await enlargeControl(page)
    test.skip(!(await enlarge.isVisible()), `no prioritization row shows the prototype of ${prototype.projectId}`)

    await enlarge.click()
    // The overlay is named after the prototype (ModalShell; "Prototype" when it has no title).
    const overlay = dialogNamed(page, prototype.title)
    await expect(overlay).toBeVisible()
    const frameElement = overlay.locator('iframe').first()
    const frame = await (await frameElement.elementHandle())?.contentFrame()
    expect(frame, 'the overlay renders the prototype in a frame').toBeTruthy()
    await frame?.waitForLoadState('domcontentloaded')
    // What a prototype's own script may do: replace its document (listeners on the old one are gone).
    await frame?.evaluate(() => {
      document.open()
      document.write('<!doctype html><html><body><button id="after-open">Inside the rewritten prototype</button></body></html>')
      document.close()
    })
    await frame?.locator('#after-open').focus()
    await page.keyboard.press('Escape')
    await expect(overlay, 'Escape from inside the frame closes the overlay').toHaveCount(0)
    await expect(enlarge, 'focus returns to Enlarge').toBeFocused()

    // And from the overlay's chrome.
    await enlarge.click()
    await expect(overlay).toBeVisible()
    await overlay.getByRole('button', { name: 'Close' }).first().focus()
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
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
