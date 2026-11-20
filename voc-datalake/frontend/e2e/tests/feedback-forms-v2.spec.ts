/**
 * Feedback Forms v2 (7.55.00, docs/feedback-forms.md): the owner's test plan, end to end, as the admin with the
 * e2e viewer for the permission steps. Run it alone after a deploy (from voc-datalake/frontend/e2e, with the suite's
 * env file sourced: README → Run):
 *
 *   E2E_SHOTS=/tmp/forms-shots npx playwright test -c playwright.config.ts --project=admin tests/feedback-forms-v2.spec.ts
 *
 * `E2E_SHOTS` is where a full-page screenshot of every screen and state goes, named `<nnn>-<step>.png` in the order
 * taken (default `$E2E_SCREENS/feedback-forms-v2`). Also runs against the dev mock (`E2E_MOCK=1`, README → Local dev
 * mock): there the viewer's steps skip (no second signed-in user) and the second AI draft carries the mock's `#slow`
 * marker, so Stop meets a draft that is still being written.
 *
 * 1. Create: four templates (NPS, Cancellation / churn, Switching back to the old interface, Bug report), each
 *    saved; Describe your form (the AI draft opens unsaved; a second draft is stopped, nothing opens); Blank.
 * 2. Builder, on the Blank form: every tab; one question of each of the ten types (a single choice with Other shown
 *    as a dropdown, a multiple choice with Other, None, chips and 1 to 2 answers); a second ending, a logic jump to
 *    it, a hidden field and Polish; Save; then a stale save from a second page gets the 409 banner.
 * 3. Test mode: the test link, opened with `hf_` and `lang`, every question answered at 1280 and at 390 px under the
 *    TEST strip; the two test responses are listed on the Test tab and never counted.
 * 4. Live: Publish, three real responses with different answers (one takes the logic jump, the open answers start
 *    with `=`, `+` and `@`), then Results (per question, the funnel, the responses table) and the CSV (labels and ids
 *    as two header rows, no formula cell).
 * 5. Permissions on deleting test responses: the e2e viewer is refused on the admin's form (403
 *    `test_responses_admin_or_creator`, with words a person can act on) and its Test tab offers no Delete; the viewer
 *    deletes on a form it created; the admin deletes on that form (as an admin, not its creator) and on its own.
 *
 * Every form is e2e-named, in the ledger (browser creates are recorded by lib/context.ts, the viewer's API create
 * here) and deleted in afterAll.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { prepareContext, test } from '../lib/test'
import { MOCK, RUN_PREFIX, SCREENS_DIR, apiUrl, storageStatePath } from '../lib/env'
import { isApi, jsonOf, roleOf, runStep, site } from '../lib/fixtures'
import { apiCall } from '../lib/api'
import { recordCreated } from '../lib/ledger'
import { isRecord } from '../lib/guards'
import { browserUserAgent } from '../lib/trafficTag'

const SHOTS_DIR = process.env['E2E_SHOTS']?.trim() || path.join(SCREENS_DIR, 'feedback-forms-v2')
const NAME = (what: string): string => `${RUN_PREFIX}forms-v2-${what}`

/** The four templates the plan names, by the start of their card's accessible name in the picker. */
const TEMPLATES: ReadonlyArray<{ readonly key: string; readonly card: RegExp }> = [
  { key: 'nps', card: /^Net Promoter Score/ },
  { key: 'churn', card: /^Cancellation \/ churn/ },
  { key: 'old-ui', card: /^Switching back to the old interface/ },
  { key: 'bug', card: /^Bug report/ },
]

/** The ten question types, as the builder's Add question menu names them, with what the step sets on each. */
const ADDED: ReadonlyArray<{ readonly menu: RegExp; readonly headline: string }> = [
  { menu: /^Single choice/, headline: 'Which plan are you on?' },
  { menu: /^Multiple choice/, headline: 'What do you use most?' },
  { menu: /^Text/, headline: 'What is your role?' },
  { menu: /^Rating/, headline: 'How do you rate the reports?' },
  { menu: /^NPS/, headline: 'How likely are you to recommend us?' },
  { menu: /^CSAT/, headline: 'How satisfied are you with support?' },
  { menu: /^CES/, headline: 'How easy was it to export a report?' },
  { menu: /^Statement/, headline: 'Almost done: two more questions.' },
  { menu: /^Consent/, headline: 'May we follow up?' },
  { menu: /^Contact info/, headline: 'Where can we reach you?' },
]

const SECOND_ENDING = 'Sorry to hear that'
const HIDDEN_FIELD = 'plan_tier'
const DESKTOP = { width: 1280, height: 900 }
const PHONE = { width: 390, height: 844 }

/** Open answers of the live responses: the CSV must quote each off as a formula. */
const FORMULA_ANSWERS = ['=SUM(A1:A9)', '+1 555 0100 call me', '@mention the team']

interface Shared {
  readonly created: Map<string, string>
  main: string | null
  viewerForm: string | null
  testLink: string | null
}
const state: Shared = { created: new Map(), main: null, viewerForm: null, testLink: null }

let shotCount = 0
/** A full-page screenshot into SHOTS_DIR, numbered in the order taken. */
async function shot(page: Page, step: string): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  // Past the widget's 200 ms screen fade and the app's own transitions.
  await page.waitForTimeout(300)
  shotCount += 1
  await page.screenshot({ path: path.join(SHOTS_DIR, `${String(shotCount).padStart(3, '0')}-${step}.png`), fullPage: true })
}

/** `runStep` without the design audit, failing the test on any problem (the evidence is on disk first). */
async function step(page: Page, name: string, action: () => Promise<void>): Promise<void> {
  const { record, problems } = await runStep({ page, role: 'admin', theme: 'light', step: `forms-v2-${name}`, audit: false, action: async () => { await action() } })
  expect(problems, `${name}: ${record.screenshot ?? ''}`).toEqual([])
}

const main = (page: Page): Locator => page.locator('main')

/** Turns a switch on or off: the app's switches are a visually hidden checkbox under its label (components/Switch). */
async function setSwitch(control: Locator, on: boolean): Promise<void> {
  if ((await control.isChecked()) !== on) await control.setChecked(on, { force: true })
  await expect(control).toBeChecked({ checked: on })
}
const builderTab = (page: Page, name: string): Locator =>
  page.getByRole('tablist', { name: 'Form builder sections' }).getByRole('tab', { name: new RegExp(`^${name}\\b`) })

async function openPicker(page: Page): Promise<void> {
  await page.goto(site('/feedback-forms/new'), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'New form', level: 1 })).toBeVisible()
}

async function renameForm(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Rename the form' }).click()
  const field = page.getByRole('textbox', { name: 'Form name (internal)' })
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

/** Save; the first save of a new form is its create (POST), whose id the address then carries. */
async function save(page: Page): Promise<string> {
  const answered = page.waitForResponse((r) => isApi(r, 'POST', /\/feedback-forms$/) || isApi(r, 'PUT', /\/feedback-forms\/[^/]+$/))
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const response = await answered
  expect(response.status(), `save -> ${response.status()}`).toBeLessThan(300)
  const body = await jsonOf(response)
  const form = isRecord(body['form']) ? body['form'] : {}
  const id = typeof form['form_id'] === 'string' ? form['form_id'] : ''
  expect(id, 'the saved form has an id').not.toBe('')
  await expect(page).toHaveURL(new RegExp(`/feedback-forms/${id}/`))
  await expect(page.getByText('Not saved yet')).toHaveCount(0)
  return id
}

/** The stored form, as the builder reads it (GET /feedback-forms/{id}). */
async function storedForm(formId: string): Promise<Record<string, unknown>> {
  const result = await apiCall('admin', 'GET', `/feedback-forms/${encodeURIComponent(formId)}`)
  expect(result.status, `GET /feedback-forms/${formId}`).toBe(200)
  const body = isRecord(result.body) ? result.body : {}
  return isRecord(body['form']) ? body['form'] : {}
}

const questionsOf = (form: Record<string, unknown>): Array<Record<string, unknown>> =>
  (Array.isArray(form['questions']) ? form['questions'] : []).filter(isRecord)
const codesOf = (question: Record<string, unknown>): string[] =>
  (Array.isArray(question['options']) ? question['options'] : []).filter(isRecord).map((o) => String(o['code']))

// ---------------------------------------------------------------------------------------------------------------
// The public form: one screen per question, answered from the stored definition
// ---------------------------------------------------------------------------------------------------------------

/** Which answer a response gives: 0 the full path, 1 a low score (the logic jump), 2 other choices. */
type Variant = 0 | 1 | 2

async function pick(question: Locator, value: string): Promise<void> {
  const select = question.locator('select.voc-select')
  if (await select.count() > 0) {
    await select.selectOption(value)
    return
  }
  const toggle = question.locator('.voc-dropdown')
  if (await toggle.count() > 0 && await toggle.first().isVisible()) {
    const input = question.locator(`input[value="${value}"]`)
    if (!(await input.first().isVisible())) await toggle.first().click()
  }
  // By keyboard: a pointer pick of a single choice or a scale moves on by itself after 300 ms (autoAdvance), a key
  // never does, so each screen is seen answered and left with its own Next.
  const input = question.locator(`input[value="${value}"]`).first()
  await input.focus()
  if (!(await input.isChecked())) await input.press('Space')
  await expect(input).toBeChecked()
}

async function answerOther(page: Page, question: Locator, text: string): Promise<void> {
  const box = question.locator('.voc-other-input').or(page.locator('.voc-other-input'))
  await box.first().fill(text)
}

async function answerQuestion(page: Page, definition: Record<string, unknown>, variant: Variant, openIndex: number): Promise<void> {
  const id = String(definition['id'])
  const question = page.locator(`fieldset.voc-question[data-question-id="${id}"]`)
  await expect(question, `question ${id} is on screen`).toBeVisible()
  const codes = codesOf(definition)
  switch (definition['type']) {
    case 'open_text':
      // The first open answer of each response starts with a formula character (one per response), the rest are plain.
      await question.locator('textarea, input').first().fill(openIndex === 0 ? FORMULA_ANSWERS[variant] ?? '=1' : `Answer ${openIndex} of response ${variant}`)
      break
    case 'single_select':
      if (variant === 1) {
        await pick(question, '#other')
        await answerOther(page, question, 'A plan of our own')
      } else {
        await pick(question, codes[variant === 0 ? 0 : 1] ?? '')
      }
      break
    case 'multi_select':
      if (variant === 1) {
        await pick(question, '#none')
      } else if (variant === 0) {
        await pick(question, codes[0] ?? '')
        await pick(question, codes[1] ?? '')
      } else {
        await pick(question, codes[2] ?? codes[0] ?? '')
        await pick(question, '#other')
        await answerOther(page, question, 'Something else entirely')
      }
      break
    case 'rating':
    case 'csat':
      await pick(question, variant === 1 ? '1' : variant === 0 ? '5' : '3')
      break
    case 'ces':
      await pick(question, variant === 1 ? '1' : variant === 0 ? '7' : '4')
      break
    case 'nps':
      await pick(question, variant === 1 ? '1' : variant === 0 ? '9' : '7')
      break
    case 'consent':
      if (variant !== 1) {
        const box = question.locator('input[type="checkbox"]').first()
        await box.focus()
        await box.press('Space')
        await expect(box).toBeChecked()
      }
      break
    case 'contact_info':
      for (const input of await question.locator('input[type="text"], input[type="email"], input[type="tel"], input:not([type])').all()) {
        const type = await input.getAttribute('type')
        await input.fill(type === 'email' ? `e2e.tester+${variant}@example.com` : type === 'tel' ? '+1 555 0100' : `E2E Tester ${variant}`)
      }
      break
    default:
      // statement: nothing to answer
      break
  }
}

/**
 * Waits for the screen after `previous` (a question id; null: the first) to have faded in, and answers its question
 * id, or null once the form shows its ending. A refused answer keeps the screen: that fails here, with the screen's
 * error in the message.
 */
async function nextScreen(page: Page, previous: string | null): Promise<string | null> {
  let shown: string | null = null
  await expect.poll(async () => {
    if (await page.locator('.voc-ending-title').isVisible()) return 'ending'
    const screen = page.locator('.voc-screen').last()
    const id = await screen.locator('fieldset.voc-question').getAttribute('data-question-id', { timeout: 1_000 }).catch(() => null)
    const opacity = await screen.evaluate((node) => getComputedStyle(node).opacity, undefined, { timeout: 1_000 }).catch(() => '0')
    if (id === null || id === previous || opacity !== '1') {
      const error = await page.locator('.voc-error, .voc-submit-error').allInnerTexts().catch(() => [])
      return `waiting (${id ?? 'none'}${error.join(' ').trim() ? `: ${error.join(' ').trim()}` : ''})`
    }
    shown = id
    return 'question'
  }, { message: `the screen after ${previous ?? 'the start'}`, timeout: 15_000 }).toMatch(/^(ending|question)$/)
  return shown
}

/**
 * Fills the public form at `url` from its first screen to its ending, answering each question the screen shows
 * (the logic decides which), with a screenshot of every screen. Returns the ids answered, in order.
 */
async function fillPublicForm(browser: Browser, url: string, form: Record<string, unknown>, options: {
  readonly variant: Variant; readonly viewport: { width: number; height: number }; readonly label: string; readonly testStrip: boolean
}): Promise<string[]> {
  // A respondent's browser: no session (the admin role only names the ledger owner of anything it could create).
  const context = prepareContext(await browser.newContext({ viewport: options.viewport, userAgent: browserUserAgent() }), 'admin')
  const page = await context.newPage()
  const seen: string[] = []
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const byId = new Map(questionsOf(form).map((q) => [String(q['id']), q]))
    const start = page.locator('.voc-start')
    if (await start.isVisible().catch(() => false)) {
      await shot(page, `${options.label}-welcome`)
      await start.click()
    }
    for (let screen = 0; screen < byId.size + 1; screen += 1) {
      const id = await nextScreen(page, seen.at(-1) ?? null)
      if (id === null) break
      const definition = byId.get(id)
      expect(definition, `screen ${screen}: a question of the form (${id})`).toBeDefined()
      if (options.testStrip) await expect(page.locator('.voc-strip'), 'the TEST strip on every screen').toBeVisible()
      await answerQuestion(page, definition ?? {}, options.variant, seen.length)
      seen.push(id)
      await shot(page, `${options.label}-q${String(seen.length).padStart(2, '0')}-${String(definition?.['type'])}`)
      // (a dropdown opened with the pointer may still move on by itself)
      const still = await page.locator('.voc-screen').last().locator('fieldset.voc-question').getAttribute('data-question-id', { timeout: 1_000 }).catch(() => null)
      if (still === id) await page.locator('.voc-next').click()
    }
    await expect(page.locator('.voc-ending-title')).toBeVisible()
    if (options.testStrip) await expect(page.locator('.voc-strip')).toBeVisible()
    await shot(page, `${options.label}-ending`)
  } finally {
    await context.close()
  }
  return seen
}

/** A page signed in as the e2e viewer (its saved session), for the permission steps. */
async function viewerPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = prepareContext(await browser.newContext({ storageState: storageStatePath('user'), viewport: DESKTOP, userAgent: browserUserAgent() }), 'user')
  return { context, page: await context.newPage() }
}

/** The smallest valid version 2 form (one open question), for the viewer's own form. */
const minimalForm = (name: string): Record<string, unknown> => ({
  schema_version: 2, name, language: 'en', languages: ['en'], enabled: false,
  welcome: { enabled: false, title: {} },
  questions: [{ id: 'q_feedback', type: 'open_text', headline: { en: 'What would you like to tell us?' }, required: true, long: true, input_type: 'text' }],
  hidden_fields: [], endings: [{ id: 'end_thanks', title: { en: 'Thank you!' } }],
  settings: { test: { link_enabled: false, record: 'tag' } },
})

/** Turns the test link on (admins only) and answers its address: `{api}/feedback-forms/{id}/iframe?test=…`. */
async function issueTestLink(formId: string): Promise<string> {
  const result = await apiCall('admin', 'POST', `/feedback-forms/${encodeURIComponent(formId)}/test-link`, { link_enabled: true, record: 'tag' })
  expect(result.status, `POST test-link -> ${result.status}`).toBe(200)
  const test = isRecord(result.body) && isRecord(result.body['test']) ? result.body['test'] : {}
  const token = typeof test['token'] === 'string' ? test['token'] : ''
  expect(token, 'the test link carries its token').not.toBe('')
  return `${apiUrl()}/feedback-forms/${encodeURIComponent(formId)}/iframe?test=${encodeURIComponent(token)}`
}

/** Deletes the form's test responses from its Test tab (Delete all… → confirm), answering the DELETE's status. */
async function deleteTestResponsesInUi(page: Page, formId: string, label: string): Promise<number> {
  await page.goto(site(`/feedback-forms/${formId}/test`), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Recent test responses' })).toBeVisible()
  await shot(page, `${label}-test-tab`)
  await page.getByRole('button', { name: 'Delete all…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete all test responses?' })
  await expect(dialog).toBeVisible()
  await shot(page, `${label}-delete-confirm`)
  const deleted = page.waitForResponse((r) => isApi(r, 'DELETE', /\/feedback-forms\/[^/]+\/responses$/))
  await dialog.getByRole('button', { name: 'Delete test responses' }).click()
  const status = (await deleted).status()
  await expect(page.getByText(/No test responses yet/)).toBeVisible()
  await shot(page, `${label}-deleted`)
  return status
}

async function testResponseCount(formId: string): Promise<number> {
  const result = await apiCall('admin', 'GET', `/feedback-forms/${encodeURIComponent(formId)}/responses?include_test=only&limit=50`)
  expect(result.status).toBe(200)
  const body = isRecord(result.body) ? result.body : {}
  return Array.isArray(body['responses']) ? body['responses'].length : 0
}

/** One CSV line split into cells (RFC 4180 quotes). */
function csvCells(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted && ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1 } else if (ch === '"') { quoted = !quoted } else if (ch === ',' && !quoted) { cells.push(cell); cell = '' } else { cell += ch }
  }
  cells.push(cell)
  return cells
}

test.describe.configure({ mode: 'serial' })

test.describe('Feedback Forms v2: the owner\'s test plan', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'the admin drives it; the viewer acts in its own context (step 5)')
  })

  test.afterAll(async () => {
    for (const id of [...state.created.values(), state.viewerForm, state.main].filter((v): v is string => v !== null)) {
      await apiCall('admin', 'DELETE', `/feedback-forms/${encodeURIComponent(id)}`, undefined, { expect: [404] }).catch(() => undefined)
    }
  })

  test('1a. create from four templates', async ({ page }) => {
    test.setTimeout(300_000)
    await step(page, 'templates', async () => {
      await page.goto(site('/feedback-forms'), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('button', { name: 'New form' })).toBeVisible()
      await shot(page, 'list')
      for (const template of TEMPLATES) {
        await openPicker(page)
        if (template === TEMPLATES[0]) await shot(page, 'picker')
        await page.getByRole('button', { name: template.card }).click()
        await expect(page.getByRole('button', { name: 'Use this template' })).toBeVisible()
        await shot(page, `template-${template.key}-preview`)
        await page.getByRole('button', { name: 'Use this template' }).click()
        await expect(page.getByText('Not saved yet')).toBeVisible()
        await shot(page, `template-${template.key}-builder`)
        await renameForm(page, NAME(template.key))
        state.created.set(template.key, await save(page))
        await shot(page, `template-${template.key}-saved`)
      }
    })
  })

  test('1b. Describe your form: the AI draft opens unsaved, and Stop drops a second one', async ({ page }) => {
    test.setTimeout(420_000)
    await step(page, 'describe', async () => {
      const writes: string[] = []
      page.on('request', (r) => { if (isApi(r, 'POST', /\/feedback-forms$/) || isApi(r, 'PUT', /\/feedback-forms\/[^/]+$/)) writes.push(r.url()) })
      await openPicker(page)
      await page.getByRole('navigation', { name: 'Start' }).getByRole('button', { name: 'Describe it' }).click()
      const panel = page.getByRole('region', { name: 'Describe your form' })
      await panel.getByRole('textbox', { name: 'Describe your form' }).fill(
        'Ask app users who switch back to the old interface why, with a few predefined reasons, then an optional comment.')
      await shot(page, 'describe-filled')
      await panel.getByRole('button', { name: 'Draft it' }).click()
      await shot(page, 'describe-drafting')
      await expect(page.getByText('AI draft: review before publishing. Nothing is saved yet.')).toBeVisible({ timeout: 180_000 })
      await expect(page.getByText('Not saved yet')).toBeVisible()
      await shot(page, 'describe-draft-opened')
      expect(writes, 'an AI draft is never saved by itself').toEqual([])

      // Back to the picker without it, then a second draft, stopped while it is written.
      await page.getByRole('button', { name: 'Discard draft' }).click()
      const discard = page.getByRole('dialog', { name: 'Discard the AI draft?' })
      await discard.getByRole('button', { name: 'Discard draft' }).click()
      await expect(page).toHaveURL(/\/feedback-forms\/new(?:\?|$)/)
      const again = page.getByRole('region', { name: 'Describe your form' })
      await again.getByRole('textbox', { name: 'Describe your form' }).fill(
        `A short NPS survey for our mobile app, with a follow-up for unhappy customers.${MOCK ? ' #slow' : ''}`)
      await again.getByRole('button', { name: 'Draft it' }).click()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: 'Stop drafting?' })
      await expect(confirm).toBeVisible()
      await shot(page, 'describe-stop-confirm')
      await confirm.getByRole('button', { name: 'Stop drafting' }).click()
      await expect(confirm).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Describe your form' }).getByRole('button', { name: 'Draft it' })).toBeVisible()
      // The stopped draft never opens, even once its job finishes on the server.
      await page.waitForTimeout(MOCK ? 3_000 : 20_000)
      await expect(page).toHaveURL(/\/feedback-forms\/new(?:\?|$)/)
      await expect(page.getByText('AI draft: review before publishing. Nothing is saved yet.')).toHaveCount(0)
      await shot(page, 'describe-stopped')
      expect(writes).toEqual([])
    })
  })

  test('1c. create from Blank', async ({ page }) => {
    await step(page, 'blank', async () => {
      await openPicker(page)
      await page.getByRole('button', { name: /^Blank form/ }).click()
      await page.getByRole('button', { name: 'Use this template' }).click()
      await expect(page.getByText('Not saved yet')).toBeVisible()
      await renameForm(page, NAME('builder'))
      state.main = await save(page)
      await shot(page, 'blank-saved')
    })
  })

  test('2. the builder: every tab, every type, logic, a hidden field, two languages, two endings, save and a stale save', async ({ page, context }) => {
    test.setTimeout(600_000)
    const formId = state.main
    test.skip(formId === null, 'needs the Blank form of 1c')
    await step(page, 'builder', async () => {
      await page.goto(site(`/feedback-forms/${formId}/questions`), { waitUntil: 'domcontentloaded' })
      await expect(builderTab(page, 'Questions')).toHaveAttribute('aria-selected', 'true')
      for (const tab of ['Questions', 'Flow', 'Languages', 'Hidden fields', 'Test', 'Share', 'Results', 'Settings']) {
        await builderTab(page, tab).click()
        await expect(builderTab(page, tab)).toHaveAttribute('aria-selected', 'true')
        await page.waitForTimeout(300)
        await shot(page, `tab-${tab.toLowerCase().replace(/\s+/g, '-')}`)
      }

      // One question of each type, appended after the Blank form's open question.
      await builderTab(page, 'Questions').click()
      for (const added of ADDED) {
        await main(page).getByRole('button', { name: 'Add question', exact: true }).click()
        await page.getByRole('menu', { name: 'Question types' }).getByRole('menuitem', { name: added.menu }).click()
        const headline = main(page).getByRole('textbox', { name: added.menu.source.includes('Statement') ? 'Text' : 'Question', exact: true })
        await headline.fill(added.headline)
        if (added.menu.source.includes('Single choice')) {
          await main(page).getByRole('textbox', { name: 'Option 1', exact: true }).fill('Free')
          await main(page).getByRole('textbox', { name: 'Option 2', exact: true }).fill('Team')
          await main(page).getByRole('button', { name: 'Add option' }).click()
          await main(page).getByRole('textbox', { name: 'Option 3', exact: true }).fill('Enterprise')
          await setSwitch(main(page).getByRole('switch', { name: '“Other” with a text box' }), true)
          await main(page).getByRole('group', { name: 'Show as' }).getByRole('button', { name: 'Dropdown' }).click()
        }
        if (added.menu.source.includes('Multiple choice')) {
          await main(page).getByRole('textbox', { name: 'Option 1', exact: true }).fill('Dashboards')
          await main(page).getByRole('textbox', { name: 'Option 2', exact: true }).fill('Exports')
          await main(page).getByRole('button', { name: 'Add option' }).click()
          await main(page).getByRole('textbox', { name: 'Option 3', exact: true }).fill('Alerts')
          await setSwitch(main(page).getByRole('switch', { name: '“Other” with a text box' }), true)
          await setSwitch(main(page).getByRole('switch', { name: /^“None of these”/ }), true)
          await main(page).getByRole('group', { name: 'Show as' }).getByRole('button', { name: 'Chips' }).click()
          await main(page).getByRole('spinbutton', { name: 'At least' }).fill('1')
          await main(page).getByRole('spinbutton', { name: 'At most' }).fill('2')
        }
        if (added.menu.source === '^Text') await main(page).getByRole('group', { name: 'Length' }).getByRole('button', { name: 'Short' }).click()
        if (added.menu.source.includes('Consent')) await main(page).getByRole('textbox', { name: 'Checkbox text' }).fill('Yes, you may contact me about my feedback.')
        await shot(page, `add-${added.menu.source.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`)
      }

      // A second ending, and a logic jump to it from the NPS question (a score of 2 or less).
      await main(page).getByRole('button', { name: 'Add ending' }).click()
      await main(page).getByRole('textbox', { name: 'Title', exact: true }).fill(SECOND_ENDING)
      await shot(page, 'second-ending')
      await main(page).getByRole('list', { name: 'Questions' }).getByRole('button', { name: /^6 NPS/ }).click()
      const logic = main(page).getByRole('region', { name: /^Logic/ })
      await logic.getByRole('button', { name: /^Logic/ }).click()
      await logic.getByRole('button', { name: 'Add rule' }).click()
      await logic.getByRole('combobox', { name: 'Rule 1: operator' }).selectOption({ label: 'is at most' })
      await logic.getByRole('combobox', { name: 'Rule 1: value' }).selectOption({ label: '2' })
      const target = logic.getByRole('combobox', { name: 'Rule 1: go to' })
      const endingOption = target.locator('option', { hasText: SECOND_ENDING })
      await target.selectOption({ label: (await endingOption.first().textContent())?.trim() ?? SECOND_ENDING })
      await shot(page, 'logic-jump')

      // A hidden field.
      await builderTab(page, 'Hidden fields').click()
      await main(page).getByRole('button', { name: 'Add field' }).first().click()
      await main(page).getByRole('textbox', { name: /^ID/ }).first().fill(HIDDEN_FIELD)
      await main(page).getByRole('button', { name: 'Add', exact: true }).click()
      await expect(main(page).getByRole('cell', { name: HIDDEN_FIELD, exact: true })).toBeVisible()
      await shot(page, 'hidden-field')

      // A second language.
      await builderTab(page, 'Languages').click()
      await main(page).getByRole('combobox', { name: 'Add language' }).selectOption({ label: 'Polski' })
      await expect(main(page).getByText('Polski').first()).toBeVisible()
      await shot(page, 'languages-polish')

      await save(page)
      await shot(page, 'builder-saved')
      const stored = await storedForm(formId ?? '')
      const types = questionsOf(stored).map((q) => q['type'])
      expect(new Set(types), 'one question of each of the ten types').toEqual(new Set([
        'open_text', 'single_select', 'multi_select', 'rating', 'nps', 'csat', 'ces', 'statement', 'consent', 'contact_info']))
      expect(stored['languages']).toEqual(['en', 'pl'])
      expect((Array.isArray(stored['endings']) ? stored['endings'] : []).length).toBe(2)
      expect(JSON.stringify(stored['hidden_fields'])).toContain(HIDDEN_FIELD)

      // A stale save: a second page saves over the first one's newer save.
      const stale = await context.newPage()
      await stale.goto(site(`/feedback-forms/${formId}/questions`), { waitUntil: 'domcontentloaded' })
      await expect(stale.getByRole('heading', { name: NAME('builder'), level: 1 })).toBeVisible()
      await renameForm(page, NAME('builder2'))
      await save(page)
      await renameForm(stale, NAME('builder-stale'))
      const conflict = stale.waitForResponse((r) => isApi(r, 'PUT', /\/feedback-forms\/[^/]+$/))
      await stale.getByRole('button', { name: 'Save', exact: true }).click()
      expect((await conflict).status(), 'the stale save is refused').toBe(409)
      await expect(stale.getByText(/You saved this form at .+, in another tab or window\.|Someone else saved this form while you were editing it\./)).toBeVisible()
      await expect(stale.getByRole('button', { name: 'Save mine' })).toBeVisible()
      await shot(stale, 'stale-save-conflict')
      await stale.getByRole('button', { name: 'Compare' }).click()
      await shot(stale, 'stale-save-compare')
      await stale.keyboard.press('Escape')
      await stale.getByRole('button', { name: 'Reload theirs' }).click()
      await expect(stale.getByRole('heading', { name: NAME('builder2'), level: 1 })).toBeVisible()
      await shot(stale, 'stale-save-reloaded')
      await stale.close()
      expect(await storedForm(formId ?? '')).toMatchObject({ name: NAME('builder2') })
    })
  })

  test('3. test mode: the test link with hf_ and lang, every question at 1280 and 390, never counted', async ({ page, browser }) => {
    test.setTimeout(420_000)
    const formId = state.main
    test.skip(formId === null, 'needs the form of 2')
    await step(page, 'test-mode', async () => {
      await page.goto(site(`/feedback-forms/${formId}/test`), { waitUntil: 'domcontentloaded' })
      await setSwitch(main(page).getByRole('switch', { name: 'Test link' }), true)
      const make = main(page).getByRole('button', { name: 'Make the test link' })
      if (await make.isVisible().catch(() => false)) {
        await shot(page, 'test-link-none-yet')
        const issued = page.waitForResponse((r) => isApi(r, 'POST', /\/feedback-forms\/[^/]+\/test-link$/))
        await make.click()
        expect((await issued).status(), 'POST …/test-link').toBe(200)
      }
      const linkBox = main(page).getByRole('textbox', { name: 'Test link' })
      await expect(linkBox).toHaveValue(/[?&]test=/)
      state.testLink = await linkBox.inputValue()
      await shot(page, 'test-link-on')
      if (await page.getByRole('button', { name: 'Save', exact: true }).isEnabled()) await save(page)

      const form = await storedForm(formId ?? '')
      const link = state.testLink
      const answered = await fillPublicForm(browser, `${link}&lang=pl&hf_${HIDDEN_FIELD}=pro`, form,
        { variant: 0, viewport: DESKTOP, label: 'test-desktop-pl', testStrip: true })
      const every = questionsOf(form).map((q) => String(q['id']))
      expect(answered, `every question answered on the full path (answered ${answered.join(', ')}; the form has ${every.join(', ')})`).toEqual(every)
      await fillPublicForm(browser, `${link}&lang=en&hf_${HIDDEN_FIELD}=free`, form,
        { variant: 0, viewport: PHONE, label: 'test-phone-en', testStrip: true })

      expect(await testResponseCount(formId ?? ''), 'both test responses are kept, marked test').toBe(2)
      expect(await storedForm(formId ?? ''), 'and never counted').toMatchObject({ response_count: 0 })
      await page.goto(site(`/feedback-forms/${formId}/test`), { waitUntil: 'domcontentloaded' })
      await expect(main(page).getByRole('list', { name: 'Recent test responses' }).getByRole('listitem')).toHaveCount(2)
      await shot(page, 'test-responses-listed')
      await page.goto(site(`/feedback-forms/${formId}/results`), { waitUntil: 'domcontentloaded' })
      await expect(main(page).getByRole('switch', { name: 'Include test responses' })).toBeVisible()
      await shot(page, 'results-without-tests')
    })
  })

  test('4. live: three real responses, Results, the funnel, the responses table and the CSV', async ({ page, browser }) => {
    test.setTimeout(600_000)
    const formId = state.main
    test.skip(formId === null, 'needs the form of 2')
    await step(page, 'live', async () => {
      await page.goto(site(`/feedback-forms/${formId}/questions`), { waitUntil: 'domcontentloaded' })
      const published = page.waitForResponse((r) => isApi(r, 'PUT', /\/feedback-forms\/[^/]+$/))
      await page.getByRole('button', { name: 'Publish' }).click()
      expect((await published).status()).toBeLessThan(300)
      await expect(await storedForm(formId ?? '')).toMatchObject({ enabled: true })
      await shot(page, 'published')

      const form = await storedForm(formId ?? '')
      const live = `${apiUrl()}/feedback-forms/${encodeURIComponent(formId ?? '')}/iframe`
      await fillPublicForm(browser, `${live}?hf_${HIDDEN_FIELD}=team`, form, { variant: 0, viewport: DESKTOP, label: 'live-1', testStrip: false })
      const jumped = await fillPublicForm(browser, `${live}?lang=pl`, form, { variant: 1, viewport: PHONE, label: 'live-2-jump', testStrip: false })
      expect(jumped.at(-1), 'a score of 2 or less ends at the second ending, after the NPS question').toBe(
        questionsOf(form).find((q) => q['type'] === 'nps')?.['id'])
      await fillPublicForm(browser, `${live}?hf_${HIDDEN_FIELD}=enterprise`, form, { variant: 2, viewport: DESKTOP, label: 'live-3', testStrip: false })

      // The responses reach Results once processed (a deployment queues them; the mock answers at once).
      await expect.poll(async () => {
        const result = await apiCall('admin', 'GET', `/feedback-forms/${encodeURIComponent(formId ?? '')}/responses?include_test=false&limit=50`)
        const body = isRecord(result.body) ? result.body : {}
        return Array.isArray(body['responses']) ? body['responses'].length : -1
      }, { timeout: MOCK ? 10_000 : 300_000, intervals: [5_000] }).toBe(3)

      await page.goto(site(`/feedback-forms/${formId}/results`), { waitUntil: 'domcontentloaded' })
      await builderTab(page, 'Results').click()
      await page.getByRole('combobox', { name: 'Time range' }).selectOption({ label: 'All time' })
      for (const added of ADDED.filter((a) => !a.menu.source.includes('Statement'))) {
        await expect(main(page).getByRole('region', { name: new RegExp(added.headline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeVisible()
      }
      // The funnel needs the opens the widget's beacon counted; the dev mock counts none for a new form.
      if (!MOCK) await expect(main(page).getByText('Drop-off')).toBeVisible()
      await shot(page, 'results-summary')
      await main(page).getByRole('group', { name: 'Results view' }).getByRole('button', { name: 'Responses' }).click()
      await expect(main(page).getByRole('table').getByRole('row')).toHaveCount(4)
      await shot(page, 'results-responses')

      // 7.61.00: Download is the familiar layout; the two header rows (labels, then ids) are the detailed one's.
      await main(page).getByRole('button', { name: 'More download options' }).click()
      const download = page.waitForEvent('download')
      await page.getByRole('menuitem', { name: 'Detailed CSV (for scripts)' }).click()
      const file = await (await download).path()
      const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l !== '')
      const [labels = [], ids = []] = lines.slice(0, 2).map(csvCells)
      expect(labels.join(' '), 'the first header row is the labels').toContain(ADDED[0]?.headline ?? '')
      const questionIds = questionsOf(form).map((q) => String(q['id']))
      expect(ids, 'the second header row is the ids').toEqual(expect.arrayContaining(questionIds.filter((id) => !id.startsWith('q_statement'))))
      expect(lines.length - 2, 'one row per real response').toBe(3)
      const cells = lines.slice(2).flatMap(csvCells)
      for (const answer of FORMULA_ANSWERS) {
        const cell = cells.find((c) => c.includes(answer.slice(1)))
        expect(cell, `the open answer ${answer} is in the CSV`).toBeDefined()
        expect(cell?.startsWith(answer[0] ?? ''), `${answer} is quoted off as a formula`).toBe(false)
      }
    })
  })

  test('5. permissions: deleting test responses as the creator, the e2e viewer and the admin', async ({ page, browser }) => {
    test.setTimeout(420_000)
    const formId = state.main
    test.skip(formId === null, 'needs the form of 2')
    await step(page, 'permissions', async () => {
      if (!MOCK) {
        // The viewer, neither an admin nor the creator of the admin's form: refused, in words, and offered no Delete.
        const refused = await apiCall('user', 'DELETE', `/feedback-forms/${encodeURIComponent(formId ?? '')}/responses?test=true`, undefined, { expect: [403] })
        expect(refused.status).toBe(403)
        const body = isRecord(refused.body) ? refused.body : {}
        expect(body['code']).toBe('test_responses_admin_or_creator')
        expect(String(body['error'] ?? ''), 'a message that says who may').toMatch(/admin|creator|created/i)
        const viewer = await viewerPage(browser)
        try {
          await viewer.page.goto(site(`/feedback-forms/${formId}/test`), { waitUntil: 'domcontentloaded' })
          await expect(viewer.page.getByText("Test responses are kept until an administrator or the form's creator deletes them.")).toBeVisible()
          await expect(viewer.page.getByRole('button', { name: 'Delete all…' })).toHaveCount(0)
          await shot(viewer.page, 'viewer-test-tab-refused')

          // The viewer's own form: a test response, deleted by its creator.
          const created = await apiCall('user', 'POST', '/feedback-forms', minimalForm(NAME('viewer')))
          expect(created.status, `viewer POST /feedback-forms -> ${created.status}`).toBeLessThan(300)
          const createdForm = isRecord(created.body) && isRecord(created.body['form']) ? created.body['form'] : {}
          state.viewerForm = typeof createdForm['form_id'] === 'string' ? createdForm['form_id'] : null
          expect(state.viewerForm).not.toBeNull()
          recordCreated('feedback-form', state.viewerForm ?? '', NAME('viewer'), 'user')
          const viewerLink = await issueTestLink(state.viewerForm ?? '')
          const viewerDefinition = await storedForm(state.viewerForm ?? '')
          await fillPublicForm(browser, viewerLink, viewerDefinition, { variant: 0, viewport: PHONE, label: 'viewer-form-test', testStrip: true })
          expect(await testResponseCount(state.viewerForm ?? '')).toBe(1)
          expect(await deleteTestResponsesInUi(viewer.page, state.viewerForm ?? '', 'viewer-creator'), 'the creator may delete').toBe(200)

          // The admin on the viewer's form: allowed as an admin, not as its creator.
          await fillPublicForm(browser, viewerLink, viewerDefinition, { variant: 2, viewport: DESKTOP, label: 'viewer-form-test-2', testStrip: true })
          expect(await deleteTestResponsesInUi(page, state.viewerForm ?? '', 'admin-not-creator'), 'an admin may delete').toBe(200)
          expect(await testResponseCount(state.viewerForm ?? '')).toBe(0)
        } finally {
          await viewer.context.close()
        }
      }
      // The admin, also the creator, on its own form: the two test responses of 3 go, the real ones stay.
      expect(await deleteTestResponsesInUi(page, formId ?? '', 'admin-creator'), 'the creator and admin may delete').toBe(200)
      expect(await testResponseCount(formId ?? '')).toBe(0)
      expect(await storedForm(formId ?? '')).toMatchObject({ response_count: 3 })
    })
  })
})
