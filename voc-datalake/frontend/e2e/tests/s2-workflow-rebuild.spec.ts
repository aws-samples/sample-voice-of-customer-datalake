/**
 * Track s2 — F4 "Workflow editor rebuilds the built-in" (E2E-COVERAGE-GAPS.md §3).
 *
 * Owner: "you can not build it manually … make sure you can build the standard
 * workflow". As e2e-admin, on e2e-named data only:
 *
 *  1. GET /workflows/wf_default (the built-in "Reviews → Prototype");
 *  2. POST /agents creates an e2e agent (never enabled, never run);
 *  3. on its Workflow tab: Clear canvas, then — palette, canvas and side panel
 *     only — add every step of the built-in (title, role, instructions,
 *     params), every arrow with its condition (pass / fail / agreed / not
 *     agreed / always) through "Add arrow", every loop through "Add to loop",
 *     and configure each loop by CLICKING its frame on the canvas (loop 1) or
 *     focusing it + Enter (the others): exit condition and max rounds;
 *  4. Save as an e2e-named workflow, then GET it and the built-in and diff them
 *     (ids and positions aside) — they must be equal — and POST /workflows/validate;
 *  5. e2e-user opens the same tab: palette disabled, step and loop settings
 *     read-only;
 *  6. cleanup: archive the agent, then every workflow this run created from the
 *     Workflow library (Archive → confirm → DELETE /workflows/{id}); the built-in
 *     row has no Archive and the API answers it 409; GET proves it.
 *
 * Not covered here (AC "a fail verdict takes the fail edge and the loop stops at
 * max iterations"): running the built-in selects or creates a REAL project and
 * writes into it, which the production data rules forbid. The runtime branch and
 * loop-cap logic is covered by lambda/agents/test/test_conductor_run.py.
 *
 * Production, alone, without the shared setup/teardown (it signs both roles in itself
 * and cleans up in s2wr-99):
 *   npx playwright test -c playwright.config.ts --project=admin --no-deps tests/s2-workflow-rebuild.spec.ts
 * Local dev mock (no auth; skips the e2e-user step):
 *   PORT=3317 node mock-server.js &  VITE_API_ENDPOINT=http://localhost:3317 npx vite --port 5317 &
 *   E2E_MOCK=1 E2E_SITE=http://localhost:5317 E2E_API=http://localhost:3317 \
 *     npx playwright test -c playwright.config.ts --project=admin --no-deps tests/s2-workflow-rebuild.spec.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { prepareContext, test } from '../lib/test'
import { apiCall, listOf, stringField, type ApiResult } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { AUTH_DIR, BUILTIN_WORKFLOW_ID, MOCK, OUT_DIR, RUN_PREFIX, storageStatePath, type Role } from '../lib/env'
import { isRecord } from '../lib/guards'
import { isApi, jsonOf, runStep, settle, site } from '../lib/fixtures'
import { recordCreated, runLedger } from '../lib/ledger'
import { loginThroughUi } from '../lib/session'
import { archiveWorkflowsInLibrary, expectBuiltinNotArchivable } from '../lib/workflows'
import type { StepRecorder } from '../lib/recorder'

const NAME = { agent: `${RUN_PREFIX}wf-rebuild-agent`, workflow: `${RUN_PREFIX}wf-rebuild` }
const STATE_FILE = path.join(OUT_DIR, 's2-workflow-rebuild-state.json')

// ── the app's English strings (the UI the spec drives) ────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_LOCALE: unknown = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../public/locales/en/agents.json'), 'utf8'))

/** `agents.json` string at a dotted key (throws when missing, so a renamed key fails loudly). */
function text(key: string): string {
  const value = key.split('.').reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), AGENTS_LOCALE)
  if (typeof value !== 'string') throw new Error(`agents.json has no string at ${key}`)
  return value
}

// ── the definition model, read leniently from API answers ─────────────────────
interface Step { id: string; type: string; title: string; role: string | null; instructions: string; params: Record<string, unknown> }
interface Arrow { source: string; target: string; label: string | null }
interface Loop { node_ids: string[]; until: string; max_rounds: number }
interface Definition { name: string; description: string; steps: Step[]; arrows: Arrow[]; loops: Loop[] }

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const records = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRecord) : [])

function readDefinition(body: unknown): Definition {
  const workflow = isRecord(body) && isRecord(body['workflow']) ? body['workflow'] : {}
  const raw = isRecord(workflow['definition']) ? workflow['definition'] : {}
  return {
    name: str(raw['name']),
    description: str(raw['description']),
    steps: records(raw['nodes']).map((n) => {
      const data = isRecord(n['data']) ? n['data'] : {}
      return {
        id: str(n['id']), type: str(n['type']), title: str(data['title']),
        role: typeof data['role'] === 'string' ? data['role'] : null,
        instructions: str(data['instructions']),
        params: isRecord(data['params']) ? data['params'] : {},
      }
    }),
    arrows: records(raw['edges']).map((e) => ({
      source: str(e['source']), target: str(e['target']), label: typeof e['label'] === 'string' ? e['label'] : null,
    })),
    loops: records(raw['loops']).map((l) => ({
      node_ids: Array.isArray(l['node_ids']) ? l['node_ids'].map(str) : [],
      until: str(l['until']),
      max_rounds: typeof l['max_rounds'] === 'number' ? l['max_rounds'] : 0,
    })),
  }
}

/** What a workflow MEANS: steps by title, arrows and loops by step titles; ids and positions dropped. */
function semantics(definition: Definition) {
  const title = (id: string) => definition.steps.find((s) => s.id === id)?.title ?? `?${id}`
  const byText = (a: string, b: string) => a.localeCompare(b)
  return {
    description: definition.description,
    steps: definition.steps
      .map(({ type, title: t, role, instructions, params }) => ({ type, title: t, role, instructions, params: canonical(params) }))
      .sort((a, b) => byText(a.title, b.title)),
    arrows: definition.arrows.map((a) => `${title(a.source)} → ${title(a.target)} [${a.label ?? 'always'}]`).sort(byText),
    loops: definition.loops
      .map((l) => ({ steps: l.node_ids.map(title).sort(byText), until: l.until, max_rounds: l.max_rounds }))
      .sort((a, b) => byText(a.steps.join('|'), b.steps.join('|'))),
  }
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])))
}

// ── state, evidence, API ──────────────────────────────────────────────────────
interface State { agentId?: string; workflowId?: string }

function readState(): State {
  if (!fs.existsSync(STATE_FILE)) return {}
  const raw: unknown = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  return isRecord(raw) ? { agentId: stringField(raw, 'agentId'), workflowId: stringField(raw, 'workflowId') } : {}
}

function writeState(patch: State): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2))
}

function saveJson(name: string, value: unknown): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(value, null, 2))
}

/** The API as a role (`apiCall` sends the dev mock no token). */
const api = (role: Role, method: string, apiPath: string, body?: unknown): Promise<ApiResult> => apiCall(role, method, apiPath, body)

async function contextFor(browser: Browser, role: Role): Promise<BrowserContext> {
  // The admin project's `use.storageState` also applies to browser.newContext(): the mock (no login)
  // must override it with an empty session, or the context fails on the missing file.
  const storageState = MOCK ? { cookies: [], origins: [] } : storageStatePath(role)
  return prepareContext(await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState }), role)
}

/**
 * Console errors that only the local dev mock produces: no Cognito env vars ("Invalid environment
 * config") and Vite refusing `/@fs` assets outside the worktree when node_modules is a symlink (403).
 * Production runs judge every console error.
 */
const MOCK_ONLY_NOISE = [/^Invalid environment config/, /^Failed to load resource: the server responded with a status of 403/]
const isNoise = (message: string): boolean => MOCK && MOCK_ONLY_NOISE.some((pattern) => pattern.test(message))

async function step(page: Page, name: string, action: (r: StepRecorder) => Promise<void>, role: Role = 'admin'): Promise<void> {
  const { record, problems } = await runStep({ page, role, theme: 'dark', step: `s2wr-${name}`, action })
  const consoleErrors = record.console
    .filter((c) => c.type === 'error' && !isNoise(c.text))
    .map((c) => `console: ${c.text.slice(0, 160)}`)
  expect([...problems, ...consoleErrors], `${name}: ${record.screenshot ?? ''}`).toEqual([])
}

function requireId(value: string | undefined, what: string): string {
  if (value === undefined || value === '') throw new Error(`no ${what} (an earlier step failed)`)
  return value
}

// ── the editor ────────────────────────────────────────────────────────────────
const panelOf = (page: Page): Locator => page.getByRole('complementary', { name: text('editor.panel') })
const paletteOf = (page: Page): Locator => page.getByRole('navigation', { name: text('editor.palette') })

async function openWorkflowTab(page: Page, agentId: string): Promise<void> {
  await page.goto(site(`/agents/${agentId}?tab=workflow`), { waitUntil: 'domcontentloaded' })
  await settle(page, 800)
  await expect(page.locator('.react-flow__pane')).toBeVisible()
}

/** Back to "nothing selected" (workflow settings + outline). */
async function toWorkflowSettings(page: Page): Promise<void> {
  const back = panelOf(page).getByRole('button', { name: text('editor.backToWorkflow') })
  if (await back.isVisible()) await back.click()
  await expect(panelOf(page).getByLabel(text('editor.fields.description'))).toBeVisible()
}

async function selectStepByTitle(page: Page, title: string): Promise<void> {
  await toWorkflowSettings(page)
  await panelOf(page).getByRole('button', { name: text('editor.selectStep').replace('{{title}}', title), exact: true }).click()
  await expect(panelOf(page).getByLabel(text('editor.fields.title'), { exact: true })).toHaveValue(title)
}

/** The option label a `<select>` shows for an enum value (`edgeLabels.pass` → "Pass"). */
const optionLabel = (group: string, value: string): string => text(`${group}.${value}`)

async function setParams(panel: Locator, s: Step): Promise<void> {
  const { params } = s
  if (s.type === 'persona_review' || s.type === 'revise_document') {
    const target = typeof params['target'] === 'string' ? optionLabel('reviewTargets', params['target']) : text('editor.params.targetAny')
    await panel.getByLabel(text('editor.params.target')).selectOption({ label: target })
  }
  if (s.type === 'end') {
    const status = typeof params['status'] === 'string' ? params['status'] : 'completed'
    await panel.getByLabel(text('editor.params.endStatus')).selectOption({ label: optionLabel('endStatuses', status) })
  }
  if (s.type === 'deep_research') await panel.getByLabel(text('editor.params.useWebSearch')).setChecked(params['use_web_search'] === true)
  if (s.type === 'generate_personas' && typeof params['max_new'] === 'number') {
    await panel.getByLabel(text('editor.params.maxNew')).fill(String(params['max_new']))
  }
}

/** Palette click (adds + selects the step), then the side panel: title, role, instructions, params. */
async function addStep(page: Page, s: Step, minted: Set<string>): Promise<string> {
  await paletteOf(page).getByRole('button', { name: text(`nodeTypes.${s.type}.label`), exact: true }).click()
  const panel = panelOf(page)
  const idCell = panel.getByTestId('step-id')
  await expect.poll(async () => {
    const id = await idCell.textContent().catch(() => null)
    return id !== null && !minted.has(id)
  }).toBe(true)
  const id = requireId((await idCell.textContent()) ?? undefined, `minted id for ${s.title}`)
  minted.add(id)
  await panel.getByLabel(text('editor.fields.title'), { exact: true }).fill(s.title)
  await panel.getByLabel(text('editor.fields.role')).selectOption({ label: s.role === null ? text('editor.fields.roleNone') : optionLabel('roles', s.role) })
  await panel.getByLabel(/^Instructions/).fill(s.instructions)
  await setParams(panel, s)
  return id
}

/** "Add arrow" on the source step: target + condition. */
async function addArrow(page: Page, sourceTitle: string, targetTitle: string, label: string | null): Promise<void> {
  await selectStepByTitle(page, sourceTitle)
  const add = panelOf(page).getByRole('group', { name: text('editor.addArrow') })
  await add.getByLabel(text('editor.fields.arrowTarget')).selectOption({ label: targetTitle })
  if (label !== null) await add.getByLabel(text('editor.fields.label')).selectOption({ label: optionLabel('edgeLabels', label) })
  await add.getByRole('button', { name: text('editor.addArrowButton') }).click()
  // The new arrow is listed under the step's "Arrows out" (targets are unique per source).
  await expect(panelOf(page).getByText(`→ ${targetTitle}`, { exact: true })).toBeVisible()
}

/** "Add to loop" on a step: a new loop for the first member, loop `index` for the rest. */
async function joinLoop(page: Page, title: string, index: number | 'new'): Promise<void> {
  await selectStepByTitle(page, title)
  await panelOf(page).getByLabel(text('editor.fields.joinLoop'), { exact: true }).selectOption(index === 'new' ? 'new' : String(index))
  await panelOf(page).getByRole('button', { name: text('editor.joinLoop'), exact: true }).click()
}

/** Open loop `index` from the canvas: click its frame (pointer) or focus it + Enter (keyboard). */
async function openLoopFromCanvas(page: Page, index: number, how: 'click' | 'keyboard'): Promise<Locator> {
  await toWorkflowSettings(page)
  await page.locator('.react-flow__controls-fitview').click()
  await page.waitForTimeout(400)
  if (how === 'click') await page.getByTestId(`loop-frame-label-${index}`).click()
  else {
    await page.getByTestId(`rf__node-loop:${index}`).focus()
    await page.keyboard.press('Enter')
  }
  const region = panelOf(page).getByRole('region', { name: text('editor.loopTitle').replace('{{n}}', String(index + 1)) })
  await expect(region).toBeVisible()
  return region
}

async function configureLoop(region: Locator, loop: Loop): Promise<void> {
  await region.getByLabel(text('editor.fields.until')).selectOption({ label: optionLabel('loopUntil', loop.until) })
  await region.getByLabel(text('editor.fields.maxRounds')).fill(String(loop.max_rounds))
  await expect(region.getByLabel(text('editor.fields.maxRounds'))).toHaveValue(String(loop.max_rounds))
}

// ══════════════════════════════════════════════════════════════════════════════
test.describe('s2 workflow editor rebuilds the built-in (F4)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.metadata['role'] !== 'admin', 'track s2 drives both roles from the admin project')
  })

  test('s2wr-00 sign in both roles', async ({ browser }) => {
    test.skip(MOCK, 'the dev mock has no login')
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    for (const role of ['admin', 'user'] as const) {
      fs.writeFileSync(storageStatePath(role), JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 })
      const context = prepareContext(await browser.newContext({ storageState: storageStatePath(role) }), role)
      const page = await context.newPage()
      await step(page, `00-login-${role}`, async () => {
        await loginThroughUi(page, role)
        await settle(page, 500)
        await context.storageState({ path: storageStatePath(role) })
        fs.chmodSync(storageStatePath(role), 0o600)
      }, role)
      await context.close()
    }
  })

  test('s2wr-01 admin rebuilds the built-in from the palette and saves it as an e2e workflow', async ({ browser }) => {
    test.setTimeout(900_000)
    const builtinRes = await api('admin', 'GET', `/workflows/${BUILTIN_WORKFLOW_ID}`)
    expect(builtinRes.status).toBe(200)
    const builtin = readDefinition(builtinRes.body)
    expect(builtin.steps.length).toBeGreaterThan(2)

    const created = await api('admin', 'POST', '/agents', { name: NAME.agent, description: 'Created by the e2e QA suite (workflow rebuild); archived at the end of the run.' })
    expect(created.status).toBe(201)
    const agent = isRecord(created.body) && isRecord(created.body['agent']) ? created.body['agent'] : {}
    const agentId = requireId(stringField(agent, 'agent_id'), 'agent id')
    recordCreated('agent', agentId, NAME.agent)
    const ownWorkflow = stringField(agent, 'workflow_id')
    if (ownWorkflow !== undefined && ownWorkflow !== BUILTIN_WORKFLOW_ID) recordCreated('workflow', ownWorkflow, `${NAME.agent} workflow`)
    writeState({ agentId })

    const context = await contextFor(browser, 'admin')
    const page = await context.newPage()
    const ids = new Map<string, string>()

    await step(page, '01a-clear-canvas', async (r) => {
      await openWorkflowTab(page, agentId)
      await page.getByRole('button', { name: text('editor.clear') }).click()
      await dialogNamed(page, text('editor.clearTitle')).getByRole('button', { name: text('editor.clear') }).click()
      await expect(panelOf(page).getByText(text('editor.emptyCanvas'))).toBeVisible()
      await expect(page.locator('.react-flow__node-step')).toHaveCount(0)
      r.note(`built-in ${BUILTIN_WORKFLOW_ID}: ${builtin.steps.length} steps, ${builtin.arrows.length} arrows, ${builtin.loops.length} loops; canvas cleared`)
    })

    await step(page, '01b-steps-from-the-palette', async (r) => {
      const minted = new Set<string>()
      for (const s of builtin.steps) ids.set(s.id, await addStep(page, s, minted))
      await expect(page.locator('.react-flow__node-step')).toHaveCount(builtin.steps.length)
      r.note(`palette → ${[...ids.values()].join(', ')}`)
    })

    await step(page, '01c-arrows-with-conditions', async (r) => {
      const title = (id: string) => builtin.steps.find((s) => s.id === id)?.title ?? id
      for (const a of builtin.arrows) await addArrow(page, title(a.source), title(a.target), a.label)
      await expect(page.locator('.react-flow__edge')).toHaveCount(builtin.arrows.length)
      r.note(`arrows: ${builtin.arrows.map((a) => `${a.source}→${a.target}[${a.label ?? 'always'}]`).join(', ')}`)
    })

    await step(page, '01d-loops-click-and-configure', async (r) => {
      const title = (id: string) => builtin.steps.find((s) => s.id === id)?.title ?? id
      for (const [index, loop] of builtin.loops.entries()) {
        const [first, ...rest] = loop.node_ids
        await joinLoop(page, title(requireId(first, `loop ${index + 1} member`)), 'new')
        for (const member of rest) await joinLoop(page, title(member), index)
        const region = await openLoopFromCanvas(page, index, index === 0 ? 'click' : 'keyboard')
        await configureLoop(region, loop)
        r.note(`loop ${index + 1}: ${loop.node_ids.length} steps, until ${loop.until}, ${loop.max_rounds} rounds (opened by ${index === 0 ? 'click' : 'focus + Enter'})`)
      }
    })

    await step(page, '01e-describe-validate-save-as', async (r) => {
      await toWorkflowSettings(page)
      await panelOf(page).getByLabel(text('editor.fields.description')).fill(builtin.description)
      await expect(page.getByRole('status').filter({ hasText: text('editor.validUnsaved') })).toBeVisible({ timeout: 20_000 })
      await page.getByRole('button', { name: text('editor.saveAs') }).click()
      const dialog = dialogNamed(page, text('editor.saveAsTitle'))
      await dialog.getByLabel(text('editor.fields.workflowName')).fill(NAME.workflow)
      const posted = page.waitForResponse((res) => isApi(res, 'POST', /\/workflows$/))
      const switched = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/agents/${agentId}$`)))
      await dialog.getByRole('button', { name: text('editor.saveAs') }).click()
      const res = await posted
      expect(res.status()).toBe(201)
      const body = await jsonOf(res)
      const workflowId = requireId(stringField(isRecord(body['workflow']) ? body['workflow'] : undefined, 'workflow_id'), 'saved workflow id')
      recordCreated('workflow', workflowId, NAME.workflow)
      writeState({ workflowId })
      r.note(`POST /workflows -> ${res.status()} ${workflowId}; agent switched: PUT /agents/{id} -> ${(await switched).status()}`)
    })

    await step(page, '01f-diff-with-the-built-in', async (r) => {
      const workflowId = requireId(readState().workflowId, 'saved workflow')
      const [saved, reference] = await Promise.all([api('admin', 'GET', `/workflows/${workflowId}`), api('admin', 'GET', `/workflows/${BUILTIN_WORKFLOW_ID}`)])
      expect([saved.status, reference.status]).toEqual([200, 200])
      const rebuilt = readDefinition(saved.body)
      expect(rebuilt.name).toBe(NAME.workflow)
      saveJson('s2-workflow-rebuild-diff.json', { rebuilt: semantics(rebuilt), builtin: semantics(readDefinition(reference.body)) })
      expect(semantics(rebuilt)).toEqual(semantics(readDefinition(reference.body)))
      const raw = isRecord(saved.body) && isRecord(saved.body['workflow']) ? saved.body['workflow']['definition'] : undefined
      const validated = await api('admin', 'POST', '/workflows/validate', { definition: raw, workflow_id: workflowId })
      expect(validated.status).toBe(200)
      expect(isRecord(validated.body) ? validated.body['valid'] : undefined).toBe(true)
      r.note(`GET /workflows/${workflowId} equals GET /workflows/${BUILTIN_WORKFLOW_ID} (ids/positions aside); POST /workflows/validate -> valid`)
    })
    await context.close()
  })

  test('s2wr-02 e2e-user sees the rebuilt workflow read-only', async ({ browser }) => {
    test.skip(MOCK, 'the dev mock serves one role per process (MOCK_AGENTS_NON_ADMIN)')
    const agentId = requireId(readState().agentId, 'agent')
    const context = await contextFor(browser, 'user')
    const page = await context.newPage()
    await step(page, '02-user-read-only', async (r) => {
      await openWorkflowTab(page, agentId)
      for (const button of await paletteOf(page).getByRole('button').all()) await expect(button).toBeDisabled()
      await expect(page.getByRole('button', { name: text('editor.clear') })).toHaveCount(0)
      const saved = (await api('user', 'GET', `/workflows/${requireId(readState().workflowId, 'workflow')}`)).body
      const reviewer = readDefinition(saved).steps.find((s) => s.type === 'final_review')
      await selectStepByTitle(page, requireId(reviewer?.title, 'final review step'))
      await expect(panelOf(page).getByLabel(text('editor.fields.title'), { exact: true })).toBeDisabled()
      await expect(panelOf(page).getByRole('group', { name: text('editor.addArrow') })).toHaveCount(0)
      const region = await openLoopFromCanvas(page, 0, 'click')
      await expect(region.getByLabel(text('editor.fields.until'))).toBeDisabled()
      await expect(region.getByLabel(text('editor.fields.maxRounds'))).toBeDisabled()
      r.note('palette disabled, no Clear canvas, step and loop settings disabled')
    }, 'user')
    await context.close()
  })

  test('s2wr-99 cleanup: archive the agent and this run\'s workflows, prove it', async ({ browser }) => {
    const proof: Array<{ action: string; status: number; detail: string }> = []
    const ledger = runLedger()
    for (const agent of ledger.filter((e) => e.kind === 'agent' && e.name === NAME.agent)) {
      const res = await api('admin', 'DELETE', `/agents/${agent.id}`)
      proof.push({ action: 'DELETE /agents/{id} (archive)', status: res.status, detail: agent.id })
    }
    // The agent's own copy of the template (POST /agents makes one) and the rebuilt workflow,
    // archived from the Workflow library on /agents (the agent first: a workflow an active agent runs is a 409).
    const names = new Set([NAME.workflow, `${NAME.agent} workflow`])
    const mine = ledger.filter((e) => e.kind === 'workflow' && names.has(e.name))
    const context = await contextFor(browser, 'admin')
    const page = await context.newPage()
    const { record, problems } = await runStep({
      page, role: 'admin', theme: 'dark', step: 's2wr-99-archive-in-library', audit: false,
      action: async (r) => {
        for (const p of await archiveWorkflowsInLibrary(page, mine.map((m) => m.id))) {
          proof.push({ action: `DELETE /workflows/{id} (archive, via ${p.via})`, status: p.status, detail: `${p.id} ${p.name}` })
          r.note(`${p.id} "${p.name}": ${p.via} -> ${p.status}`)
          if (p.via !== 'not listed') expect(p.status, `archive ${p.id}`).toBe(200)
        }
        const builtin = await expectBuiltinNotArchivable(page)
        proof.push({ action: 'Workflow library: no Archive on the built-in; DELETE /workflows/wf_default (refused)', status: builtin, detail: BUILTIN_WORKFLOW_ID })
      },
    })
    await context.close()
    const listed = await api('admin', 'GET', '/workflows')
    const left = listOf(listed.body, 'items').filter((w) => mine.some((m) => m.id === w['workflow_id']))
    proof.push({ action: 'GET /workflows (after)', status: listed.status, detail: `this run's workflows listed: ${left.length}` })
    saveJson('s2-workflow-rebuild-cleanup.json', proof)
    expect(problems, `s2wr-99: ${record.screenshot ?? ''}`).toEqual([])
    expect(left).toEqual([])
  })
})
