/**
 * Safe WRITE flows, admin only, on e2e-owned data only (every name starts
 * `e2e-<run id>`): project create -> tabs/modals -> one assistant message ->
 * delete; feedback form create -> submissions modal -> public widget GETs ->
 * delete; scraper analyze-url (https://example.com) -> save as "Manual only"
 * (never scheduled, never run) -> delete. Each created id goes to the ledger
 * first so cleanup.spec.ts can remove it whatever fails here.
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, stringField } from '../lib/api'
import { isRecord } from '../lib/guards'
import path from 'node:path'
import { E2E_PREFIX, RUN_ID, SCREENS_DIR, apiUrl } from '../lib/env'
import { isApi, jsonOf, runStep, settle, site } from '../lib/fixtures'
import { readLedger, recordCreated } from '../lib/ledger'
import { analyzeManualScraper } from '../lib/scrapers'
import { dialogNamed } from '../lib/dialogs'
import { composer, conversationLog, newChat, openFloating } from '../lib/assistant'
import { expectHealthy, headWords, lastAssistantText, plainText, runStatusOf, watchAssistantHealth } from '../lib/assistantHealth'
import { streamThreadId } from '../lib/context'
import type { StepRecorder } from '../lib/recorder'

const NAME = {
  project: `${E2E_PREFIX}${RUN_ID}-project`,
  form: `${E2E_PREFIX}${RUN_ID}-form`,
  scraper: `${E2E_PREFIX}${RUN_ID}-scraper`,
}
const ASSISTANT_PROMPT = 'Summarize this project and its personas'
const ASSISTANT_TIMEOUT_MS = 170_000
/** The manual-import AI parse ("may take 30-60 seconds"), with room for a cold start. */
const PARSE_TIMEOUT_MS = 180_000
/** Long enough that the answer is still streaming when the page reloads. The project name makes the conversation e2e-named. */
const RECOVERY_PROMPT = `${NAME.project}: write a detailed, 500-word overview of the customer feedback in this deployment. Group the main themes, quote two comments for each, and suggest one fix per theme.`
/** How much answer text must have arrived before the reload. */
const PARTIAL_ANSWER_CHARS = 80
/** followServerRun.ts FOLLOW_BOUND_MS (STALE_RUN_SECONDS 360 s): the SPA stops following after this. */
const RECOVERY_TIMEOUT_MS = 360_000
/** The rendered transcript (question + answer) vs the stored answer's plain text: rendering drops some markup. */
const SHOWN_ANSWER_RATIO = 0.8
/** assistant.json panel.stillGenerating */
const STILL_GENERATING = 'Still generating…'

/**
 * Ids survive a worker restart (Playwright starts a fresh worker after a
 * failure): read back from the ledger, keyed by this run's names.
 */
const state = {
  get projectId(): string | undefined { return readLedger().find((e) => e.kind === 'project' && e.name === NAME.project)?.id },
  get formId(): string | undefined { return readLedger().find((e) => e.kind === 'feedback-form' && e.name === NAME.form)?.id },
}

/**
 * The accessible names of the dialogs this spec opens (`dialogNamed`, never by
 * position: the floating assistant panel, opened by the assistant step, is a dialog too).
 */
const DIALOG = {
  createProject: 'Create New Project',
  deleteProject: 'Delete Project',
  formTemplates: 'Create New Form',
  // Continue on the template step swaps the wizard for the editor, a dialog of its own.
  formEditor: 'Create New Feedback Form',
  deleteForm: 'Delete Form',
  addSource: 'Add Data Source',
  manualImport: 'Manual Import',
  scraperEditor: 'New Scraper',
  deleteScraper: 'Delete Scraper',
  importPersona: 'Import Persona',
  generatePersonas: 'Generate Personas',
  sharing: `Share "${NAME.project}"`,
  buildPrototype: 'Build Prototype',
} as const satisfies Record<string, string>

type DialogName = (typeof DIALOG)[keyof typeof DIALOG]

const dialog = (page: Page, name: DialogName): Locator => dialogNamed(page, name)

/** `{ <key>: { <idKey>: id } }` -> the nested entity and its id. */
async function createdEntity(response: Response, key: string, ...idKeys: string[]): Promise<{ entity?: Record<string, unknown>; id?: string }> {
  const body = await jsonOf(response)
  const entity = isRecord(body[key]) ? body[key] : undefined
  return { entity, id: stringField(entity, ...idKeys) }
}

/** Clicks the delete button on the `.card` that shows `name`, confirms in `confirm`, returns the DELETE status. */
async function deleteViaCard(page: Page, name: string, buttonName: string, confirm: DialogName, pathPattern: RegExp): Promise<number> {
  await page.locator('.card').filter({ hasText: name }).last().getByRole('button', { name: buttonName, exact: true }).click()
  await expect(dialog(page, confirm)).toBeVisible()
  const deleted = page.waitForResponse((res) => isApi(res, 'DELETE', pathPattern))
  await dialog(page, confirm).getByRole('button', { name: 'Delete', exact: true }).click()
  return (await deleted).status()
}

async function step(page: Page, name: string, action: (r: StepRecorder) => Promise<void>, audit = true): Promise<void> {
  const { record, problems } = await runStep({ page, role: 'admin', theme: 'dark', step: name, audit, action })
  expect(problems, `${name}: ${record.screenshot ?? ''}`).toEqual([])
}

/** Like step() but a failure is soft: later modals in the same test still run. */
async function soft(page: Page, name: string, action: (r: StepRecorder) => Promise<void>): Promise<void> {
  const { record, problems } = await runStep({ page, role: 'admin', theme: 'dark', step: name, action })
  expect.soft(problems, `${name}: ${record.screenshot ?? ''}`).toEqual([])
}

/**
 * Opens, then closes with Escape (the ModalShell contract). If Escape leaves
 * it open, closes it with its Close button so the run continues, and throws so
 * the step is recorded as a FAIL with that evidence.
 */
async function openAndClose(page: Page, r: StepRecorder, trigger: Locator, name: DialogName): Promise<void> {
  await trigger.click()
  const opened = dialog(page, name)
  await expect(opened).toBeVisible()
  await settle(page, 600)
  const shot = path.join(SCREENS_DIR, `admin-dark-open-${name.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.png`)
  await page.screenshot({ path: shot }).catch(() => undefined)
  r.note(`${name} opened (screenshot ${shot})`)
  await page.keyboard.press('Escape')
  const closed = await opened.waitFor({ state: 'hidden', timeout: 4_000 }).then(() => true, () => false)
  if (closed) {
    r.note(`${name} closed with Escape`)
    return
  }
  r.note(`${name}: Escape did NOT close the dialog`)
  await opened.getByRole('button', { name: /^(Close|Cancel)$/ }).first().click()
  await expect(opened).toHaveCount(0, { timeout: 5_000 })
  throw new Error(`${name}: Escape does not close the dialog (closed with its Close button instead)`)
}

test.describe('writes (admin, e2e-owned data only)', () => {
  // Default mode, one worker: tests run in file order, and one failure does not
  // skip the rest (later tests skip themselves if the entity they need is missing).
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.metadata['role'] !== 'admin', 'write flows run as admin only')
  })

  test('project: create', async ({ page }) => {
    await step(page, 'write-project-create', async (r) => {
      await page.goto(site('/projects'), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      await page.getByRole('button', { name: /^(New Project|Create Project)$/ }).first().click()
      const create = dialog(page, DIALOG.createProject)
      await create.getByLabel('Project Name').fill(NAME.project)
      await create.getByLabel('Description').fill('Created by the e2e suite; deleted at the end of the run.')
      const created = page.waitForResponse((res) => isApi(res, 'POST', /\/projects$/))
      await create.getByRole('button', { name: 'Create Project' }).click()
      const response = await created
      const { id } = await createdEntity(response, 'project', 'project_id', 'id')
      r.note(`POST /projects -> ${response.status()} id=${id ?? '?'}`)
      expect(response.status()).toBeLessThan(300)
      expect(id).toBeTruthy()
      if (id !== undefined) recordCreated('project', id, NAME.project)
      await settle(page)
    })
  })

  test('project: tabs and modals', async ({ page }) => {
    test.skip(state.projectId === undefined, 'no project')
    const base = `/projects/${state.projectId ?? ''}`
    const personas = async (): Promise<void> => {
      await page.goto(site(`${base}?tab=personas`), { waitUntil: 'domcontentloaded' })
      await settle(page)
    }
    await soft(page, 'write-project-import-persona-modal', async (r) => {
      await personas()
      await openAndClose(page, r, page.getByRole('button', { name: 'Import Persona' }).first(), DIALOG.importPersona)
    })
    await soft(page, 'write-project-generate-personas-wizard', async (r) => {
      await personas()
      await openAndClose(page, r, page.getByRole('button', { name: /^Generate Personas$/ }).first(), DIALOG.generatePersonas)
    })
    await soft(page, 'write-project-sharing-modal', async (r) => {
      await page.goto(site(`${base}?tab=overview`), { waitUntil: 'domcontentloaded' })
      await settle(page)
      await openAndClose(page, r, page.getByRole('button', { name: /^Share/ }).first(), DIALOG.sharing)
    })
    await soft(page, 'write-project-overview-prototype-wizard', async (r) => {
      // The Build Prototype wizard opens from the Overview tab (OverviewTab.prototypeWizard.test.tsx).
      await page.goto(site(`${base}?tab=overview`), { waitUntil: 'domcontentloaded' })
      await settle(page)
      const build = page.getByRole('button', { name: /Build Prototype/ }).first()
      await build.scrollIntoViewIfNeeded()
      if (await build.isDisabled()) {
        // cardGates (OverviewTab.tsx:93): an empty e2e project has no PRD/PR-FAQ/description to build from.
        r.note('Build Prototype disabled on an empty project (gate, expected); wizard not openable')
        return
      }
      await openAndClose(page, r, build, DIALOG.buildPrototype)
    })
  })

  test('project: one assistant message', async ({ page }) => {
    test.setTimeout(ASSISTANT_TIMEOUT_MS + 60_000)
    test.skip(state.projectId === undefined, 'no project')
    const health = watchAssistantHealth(page)
    await step(page, 'write-assistant-message', async (r) => {
      await page.goto(site(`/projects/${state.projectId ?? ''}?tab=overview`), { waitUntil: 'domcontentloaded' })
      await settle(page)
      await page.getByRole('button', { name: 'Ask the assistant' }).first().click()
      const box = page.getByRole('textbox', { name: 'Message the assistant' })
      await expect(box).toBeVisible()
      await box.fill(ASSISTANT_PROMPT)
      const streamResponse = page.waitForResponse((res) => isApi(res, 'POST', /\/chat\/stream$/), { timeout: 60_000 })
      const saved = page.waitForRequest((req) => req.method() === 'POST' && /\/chat\/conversations\/[^/]+$/.test(new URL(req.url()).pathname), { timeout: ASSISTANT_TIMEOUT_MS })
        .catch(() => null)
      const sentAt = Date.now()
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const response = await streamResponse
      r.note(`POST /chat/stream -> ${response.status()} headers in ${Date.now() - sentAt}ms`)
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeHidden({ timeout: ASSISTANT_TIMEOUT_MS })
      r.note(`run finished (Stop -> Send) after ${Date.now() - sentAt}ms`)
      const transcript = (await page.getByRole('log').or(page.locator('[aria-label="Conversation"]')).last().innerText().catch(() => '')).trim()
      r.note(`transcript chars=${transcript.length}; tail: ${transcript.slice(-300).replace(/\s+/g, ' ')}`)
      const errorShown = /stream error|something went wrong|failed/i.test(transcript.slice(-400))
      expect(errorShown, 'assistant answer must not be an error').toBe(false)
      expect(transcript.length).toBeGreaterThan(ASSISTANT_PROMPT.length + 40)
      await expect(page.getByTestId('approval-card')).toHaveCount(0)
      const saveRequest = await saved
      const convId = saveRequest === null ? undefined : decodeURIComponent(new URL(saveRequest.url()).pathname.split('/').pop() ?? '')
      if (convId !== undefined && convId !== '') {
        recordCreated('conversation', convId, `${NAME.project} assistant`)
        r.note(`conversation saved: ${convId}`)
      } else {
        r.note('no conversation save observed within the timeout')
      }
    })
    // verify F1 (2.15): the first-message save no longer races the run-start write.
    expectHealthy(health, 'during the run')
  })

  test('assistant: a reload mid-answer shows "Still generating…", then the full answer', async ({ page }) => {
    test.setTimeout(RECOVERY_TIMEOUT_MS + 120_000)
    test.skip(state.projectId === undefined, 'no project')
    const health = watchAssistantHealth(page)
    await step(page, 'write-assistant-reload-mid-stream', async (r) => {
      await page.goto(site(`/projects/${state.projectId ?? ''}?tab=overview`), { waitUntil: 'domcontentloaded' })
      await settle(page)
      await openFloating(page)
      await newChat(page)
      await composer(page).fill(RECOVERY_PROMPT)
      const streamRequest = page.waitForRequest((req) => streamThreadId(req) !== null, { timeout: 60_000 })
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const threadId = streamThreadId(await streamRequest) ?? ''
      expect(threadId, 'the run carries a conversation id').not.toBe('')
      recordCreated('conversation', threadId, `${NAME.project} assistant reload`)

      // Reload once the answer has started streaming, well before it can finish.
      const log = conversationLog(page)
      await expect.poll(async () => (await log.innerText().catch(() => '')).length, { timeout: 120_000 })
        .toBeGreaterThan(RECOVERY_PROMPT.length + PARTIAL_ANSWER_CHARS)
      const partialChars = (await log.innerText()).length
      r.note(`reloading mid-answer: thread=${threadId}, transcript ${partialChars} chars`)
      await page.reload({ waitUntil: 'domcontentloaded' })

      // s1 F3 / 2.15 server-side session: the run kept going without the tab.
      const generating = page.getByRole('status').filter({ hasText: STILL_GENERATING })
      await expect(generating).toBeVisible({ timeout: 30_000 })
      await page.screenshot({ path: path.join(SCREENS_DIR, 'admin-dark-write-assistant-still-generating.png') }).catch(() => undefined)
      r.note('after reload: "Still generating…" shown')
      await expect(generating).toBeHidden({ timeout: RECOVERY_TIMEOUT_MS })

      const stored = await apiCall('admin', 'GET', `/chat/conversations/${encodeURIComponent(threadId)}`)
      const answer = lastAssistantText(stored.body)
      r.note(`GET /chat/conversations/{id} -> ${stored.status} runStatus=${runStatusOf(stored.body) ?? '?'} answer=${answer.length} chars`)
      expect(stored.status).toBe(200)
      expect(runStatusOf(stored.body)).toBe('finished')
      const shown = (await log.innerText()).replace(/\s+/g, ' ')
      expect(shown.length, 'more of the answer than before the reload').toBeGreaterThan(partialChars)
      expect(shown, 'the transcript shows the stored answer').toContain(headWords(answer, 4))
      expect(shown.length, 'the transcript carries (nearly) the whole stored answer')
        .toBeGreaterThan(plainText(answer).length * SHOWN_ANSWER_RATIO)
    })
    expectHealthy(health, 'across the reload')
  })

  test('project: delete through the UI', async ({ page }) => {
    test.skip(state.projectId === undefined, 'no project')
    await step(page, 'write-project-delete', async (r) => {
      await page.goto(site('/projects'), { waitUntil: 'domcontentloaded' })
      await settle(page)
      await page.getByRole('button', { name: `Delete project ${NAME.project}` }).click()
      const confirm = dialog(page, DIALOG.deleteProject)
      await expect(confirm).toBeVisible()
      const deleted = page.waitForResponse((res) => isApi(res, 'DELETE', /\/projects\/[^/]+$/))
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
      const response = await deleted
      r.note(`DELETE /projects/{id} -> ${response.status()}`)
      expect(response.status()).toBeLessThan(300)
      const check = await apiCall('admin', 'GET', `/projects/${state.projectId ?? ''}`)
      r.note(`GET /projects/{id} after delete -> ${check.status}`)
      expect(check.status).toBe(404)
    })
  })

  test('feedback form: create, submissions, public widget, delete', async ({ page }) => {
    await step(page, 'write-form-create', async (r) => {
      await page.goto(site('/feedback-forms'), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      await page.getByRole('button', { name: /^(Create Form|Create Your First Form)$/ }).first().click()
      const templates = dialog(page, DIALOG.formTemplates)
      await templates.getByRole('button', { name: /NPS Survey/ }).first().click()
      await templates.getByRole('button', { name: 'Continue' }).click()
      const editor = dialog(page, DIALOG.formEditor)
      await editor.getByLabel('Form Name (Internal)').fill(NAME.form)
      const created = page.waitForResponse((res) => isApi(res, 'POST', /\/feedback-forms$/))
      await editor.getByRole('button', { name: 'Create Form', exact: true }).click()
      const response = await created
      const { id } = await createdEntity(response, 'form', 'form_id', 'id')
      r.note(`POST /feedback-forms -> ${response.status()} id=${id ?? '?'}`)
      expect(response.status()).toBeLessThan(300)
      expect(id).toBeTruthy()
      if (id !== undefined) recordCreated('feedback-form', id, NAME.form)
      await settle(page)
    })
    test.skip(state.formId === undefined, 'no form')
    const card = page.locator('.card').filter({ hasText: NAME.form }).last()
    await step(page, 'write-form-submissions-button', async (r) => {
      // A new form has 0 submissions, so the button is disabled by design (FormCard.tsx:78).
      const button = card.getByRole('button', { name: 'View Submissions' })
      await expect(button).toBeDisabled()
      r.note('View Submissions disabled on a 0-submission form (expected)')
    })
    await step(page, 'public-widget-iframe', async (r) => {
      const formId = state.formId ?? ''
      // New forms are created disabled (formTemplates.ts `enabled: false`); the
      // widget renders only an enabled form, so enable THIS e2e form on its card.
      await page.goto(site('/feedback-forms'), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      const enabled = page.waitForResponse((res) => isApi(res, 'PUT', /\/feedback-forms\/[^/]+$/))
      await page.locator('.card').filter({ hasText: NAME.form }).last().getByRole('button', { name: 'Enable form' }).click()
      r.note(`PUT /feedback-forms/{id} (enable e2e form) -> ${(await enabled).status()}`)
      // Unauthenticated, exactly as an embedding site calls them. No submit: a
      // submission would enter the real feedback table, which has no delete route.
      const configRes = await fetch(`${apiUrl()}/feedback-forms/${formId}/config`)
      r.note(`public GET /feedback-forms/{id}/config -> ${configRes.status}`)
      expect(configRes.status).toBe(200)
      await page.goto(`${apiUrl()}/feedback-forms/${formId}/iframe`, { waitUntil: 'domcontentloaded' })
      await settle(page, 1500)
      const text = (await page.locator('body').innerText()).trim()
      r.note(`public GET /feedback-forms/{id}/iframe rendered: ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
      expect(text).not.toMatch(/unavailable|Failed to load form/)
    })
    await step(page, 'write-form-delete', async (r) => {
      await page.goto(site('/feedback-forms'), { waitUntil: 'domcontentloaded' })
      await settle(page)
      const status = await deleteViaCard(page, NAME.form, 'Delete form', DIALOG.deleteForm, /\/feedback-forms\/[^/]+$/)
      r.note(`DELETE /feedback-forms/{id} -> ${status}`)
      expect(status).toBeLessThan(300)
    })
  })

  test('scraper: analyze-url, save manual-only, delete', async ({ page }) => {
    await step(page, 'write-scraper-analyze-and-save', async (r) => {
      await page.goto(site('/scrapers'), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      await page.getByRole('button', { name: 'New Source' }).click()
      await dialog(page, DIALOG.addSource).getByRole('button', { name: /Custom \(CSS Selectors\)/ }).first().click()
      const editor = dialog(page, DIALOG.scraperEditor)
      // "Manual only": the scheduled ingestor never picks it up.
      const analyzeRes = await analyzeManualScraper(page, editor, r, { name: NAME.scraper, url: 'https://example.com' })
      expect(analyzeRes.status()).toBeLessThan(500)
      await settle(page, 500)
      const saved = page.waitForResponse((res) => isApi(res, 'POST', /\/scrapers$/))
      await editor.getByRole('button', { name: 'Save Scraper' }).click()
      const saveRes = await saved
      const { entity: scraper, id } = await createdEntity(saveRes, 'scraper', 'id')
      r.note(`POST /scrapers -> ${saveRes.status()} id=${id ?? '?'} frequency_minutes=${String(scraper?.['frequency_minutes'])}`)
      expect(saveRes.status()).toBeLessThan(300)
      if (id !== undefined) recordCreated('scraper', id, NAME.scraper)
      await settle(page)
    })
    test.skip(readLedger().every((e) => e.name !== NAME.scraper), 'no scraper')
    await step(page, 'write-scraper-delete', async (r) => {
      await page.goto(site('/scrapers'), { waitUntil: 'domcontentloaded' })
      await settle(page)
      const status = await deleteViaCard(page, NAME.scraper, 'Delete', DIALOG.deleteScraper, /\/scrapers\/[^/]+$/)
      r.note(`DELETE /scrapers/{id} -> ${status}`)
      expect(status).toBeLessThan(300)
    })
  })
})

/**
 * Manual import date gate (s1 F2): `POST /scrapers/manual/confirm` refuses a whole
 * import when any review lacks a date, so the preview must say so and keep Import
 * disabled. Paste one undated review, parse it (an AI parse job; it writes no
 * feedback), clear its date, then CANCEL at the preview: the confirm route is never
 * called, so nothing is imported.
 */
test.describe('manual import: date gate, cancelled at preview (no write)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.metadata['role'] !== 'admin', 'write flows run as admin only')
  })

  test('an undated review blocks Import; Escape leaves without importing', async ({ page }) => {
    test.setTimeout(PARSE_TIMEOUT_MS + 60_000)
    const confirms: string[] = []
    page.on('request', (req) => { if (isApi(req, 'POST', /\/scrapers\/manual\/confirm$/)) confirms.push(req.url()) })
    await step(page, 'write-manual-import-date-gate', async (r) => {
      await page.goto(site('/scrapers'), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      await page.getByRole('button', { name: 'New Source' }).click()
      await dialog(page, DIALOG.addSource).getByRole('button', { name: /^Manual Import/ }).click()
      const modal = dialog(page, DIALOG.manualImport)
      await modal.getByLabel('Source URL').fill(`https://example.com/${E2E_PREFIX}${RUN_ID}-date-gate`)
      await modal.getByLabel('Paste reviews').fill(`[${E2E_PREFIX}date-gate] The export button is hard to find, otherwise a solid app.`)
      const parsed = page.waitForResponse((res) => isApi(res, 'POST', /\/scrapers\/manual\/parse$/))
      await modal.getByRole('button', { name: /^Parse Reviews/ }).click()
      r.note(`POST /scrapers/manual/parse -> ${(await parsed).status()}`)
      await expect(modal.getByRole('heading', { name: /^\d+ reviews? found$/ })).toBeVisible({ timeout: PARSE_TIMEOUT_MS })

      const dates = modal.getByLabel('Review date (required)')
      const reviews = await dates.count()
      r.note(`preview: ${reviews} review(s); first date "${await dates.first().inputValue()}"`)
      expect(reviews).toBeGreaterThan(0)
      await dates.first().fill('')
      await expect(modal.getByText(/^1 review needs a date before the import can run\.$/)).toBeVisible()
      await expect(modal.getByRole('button', { name: /^Import \d+ Reviews?$/ })).toBeDisabled()

      await page.keyboard.press('Escape')
      await expect(modal).toBeHidden()
      expect(confirms, 'POST /scrapers/manual/confirm is never sent').toEqual([])
      r.note('date gate shown, Import disabled, cancelled at preview; no confirm call')
    })
  })
})
