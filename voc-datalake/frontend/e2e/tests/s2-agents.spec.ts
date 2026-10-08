/**
 * Track s2 — autonomous agents end to end, as e2e-admin in a real browser,
 * on e2e-owned data only (every name starts `e2e-<run id>`):
 *
 *  1. the AI assistant CREATES an agent (approval card -> POST /agents), checked with GET /agents;
 *  2. the assistant EDITS it (instructions, schedule trigger, personas), checked with GET /agents/{id};
 *  3. the drag-and-drop WorkflowEditor: real HTML5 drag from the palette, handle-to-handle
 *     connects, node move, node/edge delete, undo probe, validate, save, reload round-trip,
 *     keyboard + axe;
 *  4. Run now -> follow the run to completion (events, per-node durations, Step Functions
 *     history, Lambda REPORT lines, outputs/memories); a second run is cancelled mid-way;
 *  5. duplicate / export / import, enable / disable, run history, and e2e-user refused (403 + UI);
 *  then archive + forget + delete everything created, with list-call proof.
 *
 * The workflow it runs is deliberately minimal (start -> aggregate_reviews -> custom_llm -> end)
 * so the run never selects/creates a project: a project node could pick a REAL project and
 * write into it, which the production data rules forbid.
 *
 * Run alone, without the shared setup/teardown (it proves its own cleanup in s2-99):
 *   npx playwright test -c playwright.config.ts --project=admin --no-deps tests/s2-agents.spec.ts
 * It signs both roles in itself (lib/session.ts) and saves the sessions to e2e/.auth/.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Browser, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test'
import { prepareContext, test } from '../lib/test'
import { apiCall, listOf, stringField, type ApiResult } from '../lib/api'
import { openFloating } from '../lib/assistant'
import { dialogNamed } from '../lib/dialogs'
import { REGION, accountId, physicalName, stepFunctionsExecution } from '../lib/aws'
import { LOG_LAG_PAD_MS, reportLines, statsOf, type ReportLine } from '../lib/cloudwatch'
import { AUTH_DIR, E2E_PREFIX, OUT_DIR, RUN_ID, storageStatePath, type Role } from '../lib/env'
import { isRecord } from '../lib/guards'
import { isApi, jsonOf, runStep, settle, site } from '../lib/fixtures'
import { recordCreated, runLedger } from '../lib/ledger'
import { recordRunProjects, runTargetProblems } from '../lib/agentRuns'
import { deleteConversations, deleteProjects, runConversations } from '../lib/runCleanup'
import { loginThroughUi } from '../lib/session'
import { archiveWorkflowsInLibrary, expectBuiltinNotArchivable } from '../lib/workflows'
import type { StepRecorder } from '../lib/recorder'

const NAME = {
  agent: `${E2E_PREFIX}${RUN_ID}-agent`,
  workflow: `${E2E_PREFIX}${RUN_ID}-wf`,
  duplicate: `${E2E_PREFIX}${RUN_ID}-wf-dup`,
  imported: `${E2E_PREFIX}${RUN_ID}-wf-imported`,
  savedAs: `${E2E_PREFIX}${RUN_ID}-wf-saveas`,
}
const INSTRUCTIONS = `${NAME.agent}: summarise the top three problems in two sentences each.`
const CUSTOM_INSTRUCTIONS = 'e2e QA: in at most 80 words, list the single most common customer problem.'
const ASSISTANT_TIMEOUT_MS = 170_000
const RUN_TIMEOUT_MS = 12 * 60_000
const POLL_MS = 5_000
const STATE_FILE = path.join(OUT_DIR, 's2-state.json')
const TERMINAL = new Set(['completed', 'needs_human', 'failed', 'cancelled'])

// ── persisted state (survives Playwright's worker restart after a failure) ────
interface S2State {
  agentId?: string
  workflowId?: string
  savedDefinition?: unknown
  runId?: string
  cancelRunId?: string
  conversationIds?: string[]
  memoryIds?: string[]
  windows?: Record<string, [number, number]>
}
function readState(): S2State {
  if (!fs.existsSync(STATE_FILE)) return {}
  const raw: unknown = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  return isRecord(raw) ? raw : {}
}
function writeState(patch: Partial<S2State>): S2State {
  const next = { ...readState(), ...patch }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2))
  return next
}
function saveJson(name: string, value: unknown): string {
  const file = path.join(OUT_DIR, name)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}
function markWindow(key: string, start: number): void {
  writeState({ windows: { ...(readState().windows ?? {}), [key]: [start, Date.now()] } })
}

// ── small helpers ──────────────────────────────────────────────────────────────
async function contextFor(browser: Browser, role: Role): Promise<BrowserContext> {
  return prepareContext(await browser.newContext({ storageState: storageStatePath(role), viewport: { width: 1440, height: 900 } }), role)
}

/** The agent and workflow s2-01 created, and an admin page to work on them. */
async function agentSession(browser: Browser, state: { agentId?: string; workflowId?: string }): Promise<{ aid: string; wid: string; context: BrowserContext; page: Page }> {
  const aid = requireId(state.agentId, 'agent')
  const wid = requireId(state.workflowId, 'workflow')
  const context = await contextFor(browser, 'admin')
  return { aid, wid, context, page: await context.newPage() }
}

function record(body: unknown, key: string): Record<string, unknown> {
  return isRecord(body) && isRecord(body[key]) ? body[key] : {}
}

/** Key-sorted JSON, so a round-trip compare ignores key order only. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (isRecord(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
    return v
  }
  return JSON.stringify(sort(value))
}

/** Runs a step and returns every problem: runner verdict (5xx, page errors, boundary) plus console errors. */
async function stepProblems(page: Page, name: string, action: (r: StepRecorder) => Promise<void>, role: Role): Promise<{ problems: string[]; shot: string }> {
  const { record: rec, problems } = await runStep({ page, role, theme: 'dark', step: `s2-${name}`, action })
  const consoleErrors = rec.console.filter((c) => c.type === 'error').map((c) => `console: ${c.text.slice(0, 160)}`)
  return { problems: [...problems, ...consoleErrors], shot: rec.screenshot ?? '' }
}

async function step(page: Page, name: string, action: (r: StepRecorder) => Promise<void>, role: Role = 'admin'): Promise<void> {
  const { problems, shot } = await stepProblems(page, name, action, role)
  expect(problems, `${name}: ${shot}`).toEqual([])
}

/** Like step() but soft: the rest of the test still runs. */
async function softStep(page: Page, name: string, action: (r: StepRecorder) => Promise<void>, role: Role = 'admin'): Promise<void> {
  const { problems, shot } = await stepProblems(page, name, action, role)
  expect.soft(problems, `${name}: ${shot}`).toEqual([])
}

function requireId(value: string | undefined, what: string): string {
  if (value === undefined || value === '') throw new Error(`no ${what} (an earlier step failed)`)
  return value
}

// ── the assistant ─────────────────────────────────────────────────────────────
/**
 * Sends one prompt, waits for the approval card, approves it and returns the
 * REST response the approval made. Stream TTFB / total land in the step record.
 */
async function askAndApprove(page: Page, r: StepRecorder, prompt: string, write: { method: string; path: RegExp }): Promise<Response> {
  const box = await openFloating(page)
  await box.fill(prompt)
  const stream = page.waitForResponse((res) => isApi(res, 'POST', /\/chat\/stream$/), { timeout: 60_000 })
  const sentAt = Date.now()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const streamRes = await stream
  r.note(`POST /chat/stream -> ${streamRes.status()} headers after ${Date.now() - sentAt}ms`)
  const card = page.getByTestId('approval-card').last()
  await expect(card).toBeVisible({ timeout: ASSISTANT_TIMEOUT_MS })
  r.note(`approval card visible after ${Date.now() - sentAt}ms: ${(await card.innerText()).replace(/\s+/g, ' ').slice(0, 400)}`)
  await page.screenshot({ path: path.join(OUT_DIR, 'screens', `admin-dark-s2-card-${write.method.toLowerCase()}.png`) }).catch(() => undefined)
  const written = page.waitForResponse((res) => isApi(res, write.method, write.path), { timeout: 60_000 })
  const approvedAt = Date.now()
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  const response = await written
  r.note(`${write.method} ${new URL(response.url()).pathname} after approve -> ${response.status()} in ${Date.now() - approvedAt}ms`)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeHidden({ timeout: ASSISTANT_TIMEOUT_MS })
  r.note(`assistant idle ${Date.now() - sentAt}ms after send`)
  return response
}

function watchConversationSaves(page: Page): void {
  page.on('request', (req) => {
    if (req.method() !== 'POST') return
    const match = /\/chat\/conversations\/([^/]+)$/.exec(new URL(req.url()).pathname)
    const id = match?.[1] === undefined ? undefined : decodeURIComponent(match[1])
    if (id === undefined) return
    const known = readState().conversationIds ?? []
    if (!known.includes(id)) {
      writeState({ conversationIds: [...known, id] })
      recordCreated('conversation', id, `${NAME.agent} assistant`)
    }
  })
}

// ── the editor ────────────────────────────────────────────────────────────────
const canvasOf = (page: Page): Locator => page.locator('.react-flow').filter({ has: page.locator('.react-flow__pane') }).first()
const flowNode = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`)
const nodeCount = (page: Page): Promise<number> => page.locator('.react-flow__node-step').count()

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('element has no box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** A real pointer drag (down, stepped moves, up) — what React Flow's d3-drag listens to. */
async function mouseDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps: 15 })
  await page.mouse.up()
}

async function connectHandles(page: Page, source: string, target: string): Promise<void> {
  const from = await center(flowNode(page, source).locator('.react-flow__handle.source'))
  const to = await center(flowNode(page, target).locator('.react-flow__handle.target'))
  await mouseDrag(page, from, to)
}

/** Drags a palette entry onto the canvas with the browser's native HTML5 drag-and-drop. */
async function dragFromPalette(page: Page, r: StepRecorder, label: string, at: { x: number; y: number }): Promise<void> {
  const before = await nodeCount(page)
  const palette = page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: label, exact: true })
  const pane = canvasOf(page).locator('.react-flow__pane')
  await palette.dragTo(pane, { targetPosition: at })
  await expect.poll(() => nodeCount(page), { timeout: 5_000 }).toBe(before + 1)
  r.note(`dragTo palette "${label}" -> canvas (${at.x},${at.y}): nodes ${before} -> ${before + 1}`)
}

/** Fits the view (Controls "fit view") so every node is on screen before pointer work. */
async function fitView(page: Page): Promise<void> {
  await page.locator('.react-flow__controls-fitview').click()
  await page.waitForTimeout(400)
}

async function flowEdgeIds(page: Page): Promise<string[]> {
  return page.locator('.react-flow__edge').evaluateAll((els) => els.map((el) => el.getAttribute('data-id') ?? ''))
}

/** Screen point halfway along an edge's SVG path (a curved edge's bounding-box centre is off the path). */
async function edgeMidpoint(page: Page, edgeId: string): Promise<{ x: number; y: number }> {
  return page.locator(`.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`).evaluate((el) => {
    if (!(el instanceof SVGPathElement)) throw new Error('not a path')
    const point = el.getPointAtLength(el.getTotalLength() / 2)
    const matrix = el.getScreenCTM()
    if (matrix === null) throw new Error('no CTM')
    return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f }
  })
}

const SKELETON = {
  schema: 'voc-workflow/1',
  name: NAME.workflow,
  description: 'e2e QA skeleton: start and end only; the steps in between are dragged in.',
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start', params: {} } },
    { id: 'end', type: 'end', position: { x: 0, y: 600 }, data: { title: 'Done', params: { status: 'completed' } } },
  ],
  edges: [],
  loops: [],
}

// ── run following ─────────────────────────────────────────────────────────────
interface RunEvent { seq: number; at: string; kind: string; node_id?: string; summary?: string }

async function allEvents(agentId: string, runId: string): Promise<RunEvent[]> {
  const events: RunEvent[] = []
  let after = 0
  for (let page = 0; page < 50; page += 1) {
    const res = await apiCall('admin', 'GET', `/agents/${agentId}/runs/${runId}/events?after=${after}&limit=200`)
    const items = listOf(res.body, 'items')
    for (const item of items) {
      events.push({
        seq: Number(item['seq']), at: String(item['at'] ?? ''), kind: String(item['kind'] ?? ''),
        node_id: stringField(item, 'node_id'), summary: String(item['summary'] ?? '').slice(0, 300),
      })
    }
    const next = isRecord(res.body) ? res.body['next_after'] : undefined
    if (items.length === 0 || typeof next !== 'number' || next <= after) break
    after = next
  }
  return events
}

function nodeDurations(events: readonly RunEvent[]): Array<{ node_id: string; started: string; finished: string | null; ms: number | null; outcome: string }> {
  const open = new Map<string, string>()
  const out: Array<{ node_id: string; started: string; finished: string | null; ms: number | null; outcome: string }> = []
  for (const event of events) {
    if (event.node_id === undefined) continue
    if (event.kind === 'node_started') open.set(event.node_id, event.at)
    if (event.kind === 'node_finished' || event.kind === 'node_failed') {
      const started = open.get(event.node_id) ?? event.at
      open.delete(event.node_id)
      out.push({ node_id: event.node_id, started, finished: event.at, ms: Date.parse(event.at) - Date.parse(started), outcome: event.kind })
    }
  }
  for (const [node_id, started] of open) out.push({ node_id, started, finished: null, ms: null, outcome: 'unfinished' })
  return out
}

async function waitForRun(agentId: string, runId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let run: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    const res = await apiCall('admin', 'GET', `/agents/${agentId}/runs/${runId}`)
    // Fail fast (an expired 1 h id token answers 401 and would otherwise poll to the deadline).
    if (res.status !== 200) throw new Error(`GET /agents/{id}/runs/{run_id} -> ${res.status}`)
    run = record(res.body, 'run')
    if (TERMINAL.has(String(run['status']))) return run
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return run
}

function executionArn(runId: string): string {
  return `arn:aws:states:${REGION}:${accountId()}:execution:${physicalName('voc-agent-run')}:${runId}`
}

/**
 * Fails fast, BEFORE any Run now, unless the agent runs this spec's own e2e workflow with
 * only safe steps (QA 3.00.00 S1: a missed save left the built-in template copy in place,
 * and the run created a real, model-named project).
 */
async function expectSafeRunTarget(r: StepRecorder, agentId: string): Promise<void> {
  const workflowId = requireId(readState().workflowId, 'workflow')
  const [agent, workflow] = await Promise.all([
    apiCall('admin', 'GET', `/agents/${agentId}`), apiCall('admin', 'GET', `/workflows/${workflowId}`),
  ])
  const problems = runTargetProblems(agent.body, workflow.body, { workflowId, workflowName: NAME.workflow })
  r.note(`run target: agent ${agentId} -> workflow ${workflowId} (GET ${agent.status}/${workflow.status}); problems: ${problems.join('; ') || 'none'}`)
  expect([agent.status, workflow.status]).toEqual([200, 200])
  expect(problems, 'refusing to start a run that is not on the e2e workflow').toEqual([])
}

/**
 * Records the projects a terminal run created (cleanup deletes them) and fails on any:
 * the e2e workflow has no project step, so a project means the run was not on it.
 */
async function expectRunTouchedNoProject(r: StepRecorder, agentId: string, runId: string): Promise<void> {
  const { created, reused } = await recordRunProjects(agentId, runId)
  r.note(`run ${runId} projects (journal): created ${created.join(', ') || 'none'}; reused ${reused.join(', ') || 'none'}`)
  expect.soft(created, 'a project the run created (recorded in the ledger for cleanup)').toEqual([])
  expect.soft(reused, 'a project the run wrote into').toEqual([])
}

/**
 * Clicks Run now and returns the new run's id. Production answers 500 here (F3: an empty
 * ExpressionAttributeNames after the execution already started), so on a non-202 the run is
 * found through GET /agents/{id}/runs (newest, started after the click) and the failure is
 * recorded as a problem for the step to report.
 */
async function runNowViaUi(page: Page, r: StepRecorder, agentId: string): Promise<{ runId: string; problem: string | null }> {
  await expectSafeRunTarget(r, agentId)
  const clickedAt = Date.now()
  const started = page.waitForResponse((res) => isApi(res, 'POST', new RegExp(`/agents/${agentId}/run$`)))
  await page.getByRole('button', { name: 'Run now' }).click()
  const res = await started
  const body = await jsonOf(res)
  r.note(`POST /agents/{id}/run -> ${res.status()} in ${Date.now() - clickedAt}ms ${res.status() === 202 ? '' : JSON.stringify(body).slice(0, 200)}`)
  const fromBody = stringField(record(body, 'run'), 'run_id')
  if (res.status() === 202 && fromBody !== undefined) return { runId: fromBody, problem: null }
  const alert = await page.getByRole('alert').filter({ hasText: /run|start/i }).first().innerText().catch(() => '')
  r.note(`UI after the failed start: alert "${alert}"`)
  for (let i = 0; i < 10; i += 1) {
    const newest = listOf((await apiCall('admin', 'GET', `/agents/${agentId}/runs?limit=5`)).body, 'items')
      .find((run) => Date.parse(String(run['started_at'])) >= clickedAt - 2_000)
    const id = stringField(newest, 'run_id')
    if (id !== undefined) {
      r.note(`F3: the run started regardless — ${id} status=${String(newest?.['status'])}`)
      return { runId: id, problem: `POST /agents/{id}/run -> ${res.status()} although run ${id} started` }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`POST /agents/{id}/run -> ${res.status()} and no run appeared`)
}

/** Run now, then Cancel run straight away, both through the Runs tab (ledger + state updated). */
async function startAndCancelViaUi(page: Page, r: StepRecorder, agentId: string): Promise<{ runId: string; cancelStatus: number; cancelledAt: number }> {
  const { runId } = await runNowViaUi(page, r, agentId)
  recordCreated('agent-run', runId, `${NAME.agent} run (cancelled)`)
  writeState({ cancelRunId: runId })
  // After a failed start (F3) the UI does not know the run: reload so Cancel run appears.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await settle(page, 300)
  const cancelled = page.waitForResponse((res) => isApi(res, 'POST', /\/runs\/[^/]+\/cancel$/))
  const cancelledAt = Date.now()
  await page.getByRole('button', { name: 'Cancel run' }).click()
  const res = await cancelled
  r.note(`POST /agents/{id}/runs/{run_id}/cancel -> ${res.status()} in ${Date.now() - cancelledAt}ms ${JSON.stringify(await jsonOf(res)).slice(0, 160)}`)
  const alert = await page.getByRole('alert').first().innerText().catch(() => '')
  r.note(`UI after cancel: alert "${alert}"; Cancel run still shown: ${String(await page.getByRole('button', { name: 'Cancel run' }).isVisible())}`)
  return { runId, cancelStatus: res.status(), cancelledAt }
}

/** REPORT lines per Lambda (keyed by short name) for the run window, padded for CloudWatch lag. */
function reportsFor(start: number, end: number): Record<string, ReportLine[]> {
  const fns = ['agents-api', 'agent-conductor', 'agent-nodes', 'agent-persona-panel', 'chat-stream', 'memory-extractor']
  return Object.fromEntries(fns.map((fn) => [fn, reportLines(`voc-${fn}`, start - 5_000, end + LOG_LAG_PAD_MS)]))
}

// ══════════════════════════════════════════════════════════════════════════════
/** The graph part of a definition (what a duplicate / import must preserve; the name may differ). */
function graphOf(definition: unknown): string {
  const d = isRecord(definition) ? definition : {}
  return canonical({ nodes: d['nodes'], edges: d['edges'], loops: d['loops'] })
}

test.describe('s2 autonomous agents (admin, e2e-owned data only)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.metadata['role'] !== 'admin', 'track s2 drives both roles from the admin project')
  })

  test('s2-00 sign in both roles', async ({ browser }) => {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    for (const role of ['admin', 'user'] as const) {
      // The admin project's `use.storageState` also applies to browser.newContext(): start from an
      // empty session file (overwritten by the real login below).
      fs.writeFileSync(storageStatePath(role), JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 })
      const context = prepareContext(await browser.newContext({ storageState: storageStatePath(role) }), role)
      const page = await context.newPage()
      await step(page, `login-${role}`, async () => {
        await loginThroughUi(page, role)
        await settle(page, 500)
        await context.storageState({ path: storageStatePath(role) })
        fs.chmodSync(storageStatePath(role), 0o600)
      }, role)
      await context.close()
    }
    const baseline = await apiCall('admin', 'GET', '/agents')
    const workflows = await apiCall('admin', 'GET', '/workflows')
    saveJson('s2-baseline.json', {
      agents: listOf(baseline.body, 'items').map((a) => ({ agent_id: a['agent_id'], name: a['name'], enabled: a['enabled'] })),
      workflows: listOf(workflows.body, 'items').map((w) => ({ workflow_id: w['workflow_id'], name: w['name'], revision: w['revision'] })),
    })
  })

  test('s2-01 assistant creates the agent', async ({ browser }) => {
    test.setTimeout(ASSISTANT_TIMEOUT_MS * 2)
    const context = await contextFor(browser, 'admin')
    const page = await context.newPage()
    watchConversationSaves(page)
    const t0 = Date.now()
    await step(page, '01-assistant-create-agent', async (r) => {
      await page.goto(site('/agents'), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      const response = await askAndApprove(page, r,
        `Create an autonomous agent named exactly "${NAME.agent}" that watches all categories, with the description `
        + '"Created by the e2e QA suite; archived at the end of the run." Do not set a workflow, triggers or personas. '
        + 'Propose it with create_agent now; do not ask me questions.',
        { method: 'POST', path: /\/agents$/ })
      const agent = record(await jsonOf(response), 'agent')
      const agentId = stringField(agent, 'agent_id')
      r.note(`created agent_id=${agentId ?? '?'} name=${String(agent['name'])} workflow_id=${String(agent['workflow_id'])} enabled=${String(agent['enabled'])}`)
      expect(response.status()).toBe(201)
      expect(agent['name']).toBe(NAME.agent)
      expect(agent['enabled']).toBe(false)
      const id = requireId(agentId, 'agent id')
      recordCreated('agent', id, NAME.agent)
      const workflowId = requireId(stringField(agent, 'workflow_id'), 'workflow id')
      recordCreated('workflow', workflowId, `${NAME.agent} workflow`)
      writeState({ agentId: id, workflowId })
      const listed = await apiCall('admin', 'GET', '/agents')
      const found = listOf(listed.body, 'items').find((a) => a['agent_id'] === id)
      r.note(`GET /agents -> ${listed.status} in ${listed.ms}ms, lists the new agent: ${String(found !== undefined)}`)
      expect(found?.['name']).toBe(NAME.agent)
      await page.screenshot({ path: path.join(OUT_DIR, 'screens', 'admin-dark-s2-01-after.png') })
    })
    markWindow('create', t0)
    await context.close()
  })

  test('s2-02 assistant edits the agent', async ({ browser }) => {
    test.setTimeout(ASSISTANT_TIMEOUT_MS * 2)
    const agentId = requireId(readState().agentId, 'agent')
    const context = await contextFor(browser, 'admin')
    const page = await context.newPage()
    watchConversationSaves(page)
    const t0 = Date.now()
    await step(page, '02-assistant-edit-agent', async (r) => {
      await page.goto(site(`/agents/${agentId}?tab=instructions`), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      const response = await askAndApprove(page, r,
        `Update the agent on screen (${agentId}) with ONE update_agent call that sets: instructions to exactly "${INSTRUCTIONS}"; `
        + 'triggers to exactly one schedule trigger {kind: "schedule", every: "24h", timezone: "UTC"}; personas to '
        + '{fixed: [], allow_generate: false}. Change nothing else and do not ask me questions.',
        { method: 'PUT', path: new RegExp(`/agents/${agentId}$`) })
      expect(response.status()).toBe(200)
      const got = await apiCall('admin', 'GET', `/agents/${agentId}`)
      const agent = record(got.body, 'agent')
      const triggers = Array.isArray(agent['triggers']) ? agent['triggers'] : []
      r.note(`GET /agents/{id} -> ${got.status}: instructions=${JSON.stringify(agent['instructions'])} triggers=${JSON.stringify(triggers)} personas=${JSON.stringify(agent['personas'])}`)
      expect(agent['instructions']).toBe(INSTRUCTIONS)
      expect(triggers).toEqual([expect.objectContaining({ kind: 'schedule', every: '24h', timezone: 'UTC' })])
      expect(record(agent, 'personas')['allow_generate']).toBe(false)
      expect(agent['enabled']).toBe(false)
      // The UI shows the persisted value after a reload.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await settle(page)
      await expect(page.getByRole('tabpanel', { name: 'Instructions' }).getByRole('textbox').first()).toHaveValue(INSTRUCTIONS)
    })
    markWindow('edit', t0)
    await context.close()
  })

  test('s2-03 workflow editor: drag, connect, move, delete, validate, save, round-trip, a11y', async ({ browser }) => {
    test.setTimeout(300_000)
    const { aid, wid, context, page } = await agentSession(browser, readState())
    const t0 = Date.now()
    const open = async (): Promise<void> => {
      await page.goto(site(`/agents/${aid}?tab=workflow`), { waitUntil: 'domcontentloaded' })
      await settle(page, 800)
      await expect(canvasOf(page)).toBeVisible()
    }

    await softStep(page, '03a-editor-open-and-delete-on-template-copy', async (r) => {
      await open()
      const n = await nodeCount(page)
      r.note(`agent's own template copy ${wid}: ${n} steps on the canvas`)
      expect(n).toBeGreaterThan(10)
      await fitView(page)
      // Click-select one step, delete it with the keyboard (deleteKeyCode Delete/Backspace).
      await flowNode(page, 'final_review').click()
      await page.keyboard.press('Delete')
      await expect(flowNode(page, 'final_review')).toHaveCount(0)
      await expect(page.getByText('Unsaved changes')).toBeVisible()
      r.note(`selected final_review + Delete: steps ${n} -> ${await nodeCount(page)}; "Unsaved changes" shown`)
      // Undo probe (Ctrl/Cmd+Z): the editor has no history — record what happens.
      await page.keyboard.press('ControlOrMeta+z')
      await page.waitForTimeout(300)
      const restored = await flowNode(page, 'final_review').count()
      r.note(`undo (Ctrl/Cmd+Z) restored the step: ${String(restored === 1)} (no undo/redo in useWorkflowEditor)`)
    })

    await step(page, '03b-import-skeleton', async (r) => {
      const file = saveJson('s2-skeleton.workflow.json', SKELETON)
      await page.locator('input[type=file][accept*="json"]').setInputFiles(file)
      await expect.poll(() => nodeCount(page)).toBe(2)
      r.note('Import (client-side) replaced the draft with start + end; the server is not called')
      await expect(page.getByText(NAME.workflow).first()).toBeVisible()
    })

    await step(page, '03c-drag-from-palette', async (r) => {
      await fitView(page)
      const pane = await canvasOf(page).locator('.react-flow__pane').boundingBox()
      if (pane === null) throw new Error('no pane')
      await dragFromPalette(page, r, 'Aggregate reviews', { x: pane.width * 0.3, y: pane.height * 0.35 })
      await dragFromPalette(page, r, 'Custom step', { x: pane.width * 0.3, y: pane.height * 0.6 })
      await dragFromPalette(page, r, 'Write PRD', { x: pane.width * 0.75, y: pane.height * 0.5 })
      for (const id of ['aggregate_reviews_1', 'custom_llm_1', 'write_prd_1']) await expect(flowNode(page, id)).toHaveCount(1)
    })

    await step(page, '03d-connect-edges', async (r) => {
      await fitView(page)
      const pairs: Array<[string, string]> = [['start', 'aggregate_reviews_1'], ['aggregate_reviews_1', 'custom_llm_1'], ['custom_llm_1', 'end'], ['custom_llm_1', 'write_prd_1']]
      for (const [source, target] of pairs) {
        const before = (await flowEdgeIds(page)).length
        await connectHandles(page, source, target)
        await expect.poll(async () => (await flowEdgeIds(page)).length).toBe(before + 1)
        r.note(`connected ${source} -> ${target} by dragging handle to handle`)
      }
      r.note(`edges: ${(await flowEdgeIds(page)).join(', ')}`)
    })

    await step(page, '03e-move-node', async (r) => {
      await fitView(page)
      const before = await center(flowNode(page, 'write_prd_1'))
      await mouseDrag(page, before, { x: before.x - 60, y: before.y + 90 })
      const after = await center(flowNode(page, 'write_prd_1'))
      r.note(`moved write_prd_1 on screen (${Math.round(before.x)},${Math.round(before.y)}) -> (${Math.round(after.x)},${Math.round(after.y)})`)
      expect(Math.abs(after.y - before.y)).toBeGreaterThan(40)
      // Move the custom step too (away from the PRD step): its final position is checked in the saved definition.
      const custom = await center(flowNode(page, 'custom_llm_1'))
      await mouseDrag(page, custom, { x: custom.x - 140, y: custom.y })
    })

    await softStep(page, '03f-delete-edge', async (r) => {
      const edgeId = (await flowEdgeIds(page)).find((id) => id.includes('write_prd_1'))
      const eid = requireId(edgeId, 'edge to write_prd_1')
      await fitView(page)
      const mid = await edgeMidpoint(page, eid)
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('class') ?? '', mid)
      await page.mouse.click(mid.x, mid.y)
      const selected = await page.getByRole('button', { name: 'Delete arrow' }).isVisible({ timeout: 2_000 }).catch(() => false)
      r.note(`edge ${eid}: click at its midpoint (hit "${hit}") -> selected/side panel shown: ${String(selected)} (F1: the controlled canvas dropped React Flow's edge select changes; fixed in dfa355a1, not deployed)`)
      // Keyboard path: focus the edge (it is a focusable group) and Enter.
      await page.locator(`.react-flow__edge[data-id="${eid}"]`).focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Backspace')
      const goneByKeyboard = !(await flowEdgeIds(page)).includes(eid)
      r.note(`edge ${eid}: focus + Enter + Backspace removed it: ${String(goneByKeyboard)}`)
      expect(selected, 'a clicked arrow must open its settings (Delete arrow)').toBe(true)
    })

    await step(page, '03f-delete-node', async (r) => {
      await flowNode(page, 'write_prd_1').click()
      await page.getByRole('complementary', { name: 'Step settings' }).getByRole('button', { name: 'Delete step' }).click()
      await expect(flowNode(page, 'write_prd_1')).toHaveCount(0)
      const left = (await flowEdgeIds(page)).filter((id) => id.includes('write_prd_1'))
      r.note(`write_prd_1: selected, "Delete step" in the side panel -> removed, with its arrows (left: ${left.length})`)
      expect(left).toEqual([])
    })

    await step(page, '03g-keyboard-a11y', async (r) => {
      // Palette by keyboard: focus an entry, Enter adds the step below the graph.
      const before = await nodeCount(page)
      const entry = page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: 'Hand off', exact: true })
      await entry.focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => nodeCount(page)).toBe(before + 1)
      r.note('palette: focus "Hand off" + Enter -> step added (keyboard path)')
      // Canvas by keyboard: React Flow nodes are focusable groups; arrows move the selected one.
      await fitView(page)
      const handoff = flowNode(page, 'handoff_1')
      await handoff.click()
      await handoff.focus()
      const focused = await page.evaluate(() => {
        const el = document.activeElement
        return el === null ? null : `${el.className.toString().slice(0, 60)}#${el.closest('.react-flow__node')?.getAttribute('data-id') ?? ''}`
      })
      const label = await handoff.getAttribute('aria-label')
      const role = await handoff.getAttribute('role')
      r.note(`node a11y: activeElement=${String(focused)} role=${String(role)} aria-roledescription=${String(await handoff.getAttribute('aria-roledescription'))} aria-label=${String(label)} tabindex=${String(await handoff.getAttribute('tabindex'))}`)
      const startBox = await handoff.boundingBox()
      for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(300)
      const endBox = await handoff.boundingBox()
      const moved = Math.round((endBox?.x ?? 0) - (startBox?.x ?? 0))
      r.note(`ArrowRight x6 on the selected+focused step moved it ${moved}px on screen`)
      expect.soft(moved, 'arrow keys move the focused step').toBeGreaterThan(0)
      await page.keyboard.press('Delete')
      const deletedByKey = await handoff.count() === 0
      r.note(`focused step + Delete -> removed: ${String(deletedByKey)}`)
      if (!deletedByKey) {
        await page.getByRole('complementary', { name: 'Step settings' }).getByRole('button', { name: 'Delete step' }).click()
      }
      await expect(handoff).toHaveCount(0)
      // Tab order: from the palette landmark, Tab eventually reaches the canvas steps.
      await page.getByRole('complementary', { name: 'Steps' }).focus()
      const seen: string[] = []
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press('Tab')
        const tag = await page.evaluate(() => {
          const el = document.activeElement
          return el === null ? '' : `${el.tagName.toLowerCase()}${el.getAttribute('data-id') === null ? '' : `#${el.getAttribute('data-id') ?? ''}`}${el.getAttribute('aria-label') === null ? '' : `[${el.getAttribute('aria-label') ?? ''}]`}`
        })
        seen.push(tag)
        if (tag.includes('#start')) break
      }
      r.note(`Tab walk from the palette (${seen.length} stops): ${seen.slice(-8).join(' > ')}`)
      expect(seen.some((s) => s.includes('#start'))).toBe(true)
    })

    await step(page, '03h-configure-validate', async (r) => {
      await flowNode(page, 'custom_llm_1').click()
      const panel = page.getByRole('complementary', { name: 'Step settings' })
      // By its label, in the node's settings (QA 3.00.00 S1): the first textarea of the panel is the
      // WORKFLOW Description while the workflow details are still shown, so the step stayed empty.
      const instructions = panel.getByLabel('Instructions (required)', { exact: true })
      await expect(instructions).toBeVisible()
      await instructions.fill(CUSTOM_INSTRUCTIONS)
      await expect(instructions).toHaveValue(CUSTOM_INSTRUCTIONS)
      const fieldLabels = await panel.locator('label').allInnerTexts()
      r.note(`side-panel labels: ${fieldLabels.join(' | ')}`)
      expect.soft(fieldLabels.filter((l) => l.includes('editor.fields.')), 'F2: no raw i18n key as a field label').toEqual([])
      const validated = page.waitForResponse((res) => isApi(res, 'POST', /\/workflows\/validate$/), { timeout: 20_000 })
      await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined)
      const res = await validated
      const body = await jsonOf(res)
      r.note(`POST /workflows/validate -> ${res.status()} valid=${String(body['valid'])} errors=${JSON.stringify(body['errors']).slice(0, 300)}`)
      expect(res.status()).toBe(200)
      expect(body['valid']).toBe(true)
      await expect(page.getByRole('status').filter({ hasText: 'Valid — not saved yet.' })).toBeVisible()
    })

    await step(page, '03i-save-and-round-trip', async (r) => {
      const saved = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/workflows/${wid}$`)))
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const res = await saved
      const sent: unknown = res.request().postDataJSON()
      const sentDef = record(sent, 'definition')
      const returned = record(record(await jsonOf(res), 'workflow'), 'definition')
      r.note(`PUT /workflows/{id} -> ${res.status()} expected_revision=${String(isRecord(sent) ? sent['expected_revision'] : '?')}`)
      expect(res.status()).toBe(200)
      // Reload, read back through the API, compare exactly (key order aside).
      await page.reload({ waitUntil: 'domcontentloaded' })
      await settle(page)
      const got = await apiCall('admin', 'GET', `/workflows/${wid}`)
      const stored = record(record(got.body, 'workflow'), 'definition')
      const sameAsSent = canonical(stored) === canonical(sentDef)
      r.note(`GET /workflows/{id} -> ${got.status} rev=${String(record(got.body, 'workflow')['revision'])}; stored == sent: ${String(sameAsSent)}; stored == PUT response: ${String(canonical(stored) === canonical(returned))}`)
      saveJson('s2-workflow-roundtrip.json', { sent: sentDef, stored })
      expect(sameAsSent).toBe(true)
      const nodes = Array.isArray(stored['nodes']) ? stored['nodes'].filter(isRecord) : []
      const edges = Array.isArray(stored['edges']) ? stored['edges'].filter(isRecord) : []
      expect(nodes.map((n) => n['id']).sort()).toEqual(['aggregate_reviews_1', 'custom_llm_1', 'end', 'start'])
      expect(edges.map((e) => `${String(e['source'])}>${String(e['target'])}`).sort())
        .toEqual(['aggregate_reviews_1>custom_llm_1', 'custom_llm_1>end', 'start>aggregate_reviews_1'])
      expect(stored['name']).toBe(NAME.workflow)
      const customNode = nodes.find((n) => n['id'] === 'custom_llm_1')
      expect(record(customNode, 'data')['instructions'], 'the custom step keeps its instructions').toBe(CUSTOM_INSTRUCTIONS)
      // The editor shows the saved state after reload: same steps, no unsaved badge.
      await expect.poll(() => nodeCount(page)).toBe(4)
      await expect(page.getByText('Unsaved changes')).toHaveCount(0)
      writeState({ savedDefinition: stored })
    })
    markWindow('editor', t0)
    await context.close()
  })

  test('s2-04 run now: follow to completion, then cancel a second run', async ({ browser }) => {
    test.setTimeout(RUN_TIMEOUT_MS + 240_000)
    const aid = requireId(readState().agentId, 'agent')
    const context = await contextFor(browser, 'admin')
    const page = await context.newPage()
    const t0 = Date.now()

    await step(page, '04-pre-unlabel-custom-arrow', async (r) => {
      // F4 workaround on the deployed (unfixed) runtime: a custom step reports no verdict, so its
      // editor-labelled `pass` arrow is never taken. F1 blocks re-labelling it on the canvas, so the
      // saved definition is re-imported with that arrow unlabelled ("Always") and saved.
      const wid = requireId(readState().workflowId, 'workflow')
      const current = record(record((await apiCall('admin', 'GET', `/workflows/${wid}`)).body, 'workflow'), 'definition')
      const edges = Array.isArray(current['edges']) ? current['edges'].filter(isRecord) : []
      if (!edges.some((e) => e['source'] === 'custom_llm_1' && e['label'] !== undefined)) {
        r.note('custom step arrow already unlabelled (earlier attempt); nothing to save')
        writeState({ savedDefinition: current })
        return
      }
      const fixed = { ...current, edges: edges.map((e) => (e['source'] === 'custom_llm_1' ? { id: e['id'], source: e['source'], target: e['target'] } : e)) }
      await page.goto(site(`/agents/${aid}?tab=workflow`), { waitUntil: 'domcontentloaded' })
      await settle(page, 800)
      await page.locator('input[type=file][accept*="json"]').setInputFiles(saveJson('s2-unlabelled.workflow.json', fixed))
      await expect(page.getByText('Unsaved changes')).toBeVisible()
      const saved = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/workflows/${wid}$`)))
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const res = await saved
      const stored = record(record((await apiCall('admin', 'GET', `/workflows/${wid}`)).body, 'workflow'), 'definition')
      r.note(`Import + Save -> PUT ${res.status()}; stored == imported: ${String(canonical(stored) === canonical(fixed))}`)
      expect(res.status()).toBe(200)
      expect(canonical(stored)).toBe(canonical(fixed))
      writeState({ savedDefinition: stored })
    })

    // Hard stop before any run: a failure here ends the test, so neither run below is started.
    await step(page, '04-guard-run-target', async (r) => {
      await expectSafeRunTarget(r, aid)
    })

    await softStep(page, '04a-run-now', async (r) => {
      const existing = readState().runId
      if (existing !== undefined) {
        r.note(`reusing run ${existing} started by an earlier attempt of this step (no extra run)`)
        return
      }
      await page.goto(site(`/agents/${aid}?tab=runs`), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      const { runId, problem } = await runNowViaUi(page, r, aid)
      recordCreated('agent-run', runId, `${NAME.agent} run`)
      writeState({ runId })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      r.note(`Run now disabled while the run is active: ${String(await page.getByRole('button', { name: 'Run now' }).isDisabled())}`)
      expect.soft(problem, 'Run now must answer 202').toBeNull()
    })

    await step(page, '04b-follow-run-to-completion', async (r) => {
      const runId = requireId(readState().runId, 'run')
      const run = await waitForRun(aid, runId, RUN_TIMEOUT_MS)
      await expectRunTouchedNoProject(r, aid, runId)
      const events = await allEvents(aid, runId)
      const durations = nodeDurations(events)
      const startedAt = Date.parse(String(run['started_at']))
      const finishedAt = Date.parse(String(run['finished_at']))
      if (!Number.isNaN(startedAt)) {
        // The Lambda REPORT window is the run's own lifetime (it may have started in an earlier attempt).
        writeState({ windows: { ...(readState().windows ?? {}), run: [startedAt, Number.isNaN(finishedAt) ? Date.now() : finishedAt] } })
      }
      r.note(`run ${runId}: status=${String(run['status'])} model_calls=${String(run['model_calls'])} started=${String(run['started_at'])} finished=${String(run['finished_at'])} error=${String(run['error'])}`)
      for (const d of durations) r.note(`node ${d.node_id}: ${d.outcome} ${d.ms ?? '?'}ms`)
      saveJson('s2-run-completed.json', { run, events, durations })
      await page.goto(site(`/agents/${aid}?tab=runs`), { waitUntil: 'domcontentloaded' })
      await settle(page)
      // The tab opens the NEWEST run; pick this one (the list is newest first, like the API).
      const order = listOf((await apiCall('admin', 'GET', `/agents/${aid}/runs`)).body, 'items').map((x) => x['run_id'])
      const index = order.indexOf(runId)
      expect(index, 'the run is listed').toBeGreaterThanOrEqual(0)
      await page.getByRole('list', { name: 'Runs' }).getByRole('button').nth(index).click()
      await expect(page.locator('section[aria-label="Event log"]')).toBeVisible()
      await expect.poll(() => page.locator('section[aria-label="Event log"] li').count(), { timeout: 15_000 }).toBe(events.length)
      const eventLogItems = await page.locator('section[aria-label="Event log"] li').count()
      r.note(`Runs tab (run selected in the list) event log shows ${eventLogItems} entries (API: ${events.length})`)
      expect(run['status']).toBe('completed')
      expect(durations.filter((d) => d.outcome === 'node_finished').map((d) => d.node_id)).toEqual(
        expect.arrayContaining(['aggregate_reviews_1', 'custom_llm_1']))
    })

    await softStep(page, '04c-step-functions-and-lambda-reports', async (r) => {
      const runId = requireId(readState().runId, 'run')
      const execution = stepFunctionsExecution(executionArn(runId))
      r.note(`SFN ${runId}: ${execution.status} ${execution.durationMs ?? '?'}ms, ${execution.events} history events, failures=${execution.failures.join(',') || 'none'}`)
      for (const s of execution.states.filter((x) => x.type === 'Task' || x.type === 'Map')) r.note(`state ${s.name} (${s.type}) ${s.ms ?? '?'}ms`)
      const window = readState().windows?.['run'] ?? [t0, Date.now()]
      const reports = reportsFor(window[0], window[1])
      for (const [fn, lines] of Object.entries(reports)) {
        const s = statsOf(fn, lines)
        r.note(`REPORT ${fn}: ${s.invocations} invocations, max ${Math.round(s.durationMaxMs ?? 0)}ms, cold starts ${s.coldStarts}, max mem ${s.maxMemoryUsedMb ?? 0}/${s.memorySizeMb ?? '?'}MB`)
      }
      saveJson('s2-run-aws.json', { execution, reports })
      expect(execution.status).toBe('SUCCEEDED')
      expect(reports['agent-conductor']?.length ?? 0).toBeGreaterThan(0)
      expect(reports['agent-nodes']?.length ?? 0).toBeGreaterThan(0)
    })

    await softStep(page, '04d-outputs-and-memories', async (r) => {
      const runId = requireId(readState().runId, 'run')
      const events = await allEvents(aid, runId)
      const custom = events.filter((e) => e.node_id === 'custom_llm_1' && e.kind === 'node_finished')
      r.note(`custom_llm_1 output (journal summary): ${custom[0]?.summary?.slice(0, 240) ?? 'none'}`)
      expect(custom.length).toBe(1)
      // The finished run is queued to voc-memory-extract as an agent_run source; poll for its memories.
      const found: Array<Record<string, unknown>> = []
      const deadline = Date.now() + 150_000
      while (Date.now() < deadline && found.length === 0) {
        for (const status of ['active', 'proposed']) {
          const res = await apiCall('admin', 'GET', `/memory?scope=company&status=${status}&limit=100`)
          for (const m of listOf(res.body, 'items')) {
            const source = record(m, 'source')
            if (source['type'] === 'agent_run' && String(source['ref'] ?? '').includes(runId)) found.push(m)
          }
        }
        if (found.length === 0) await new Promise((resolve) => setTimeout(resolve, 10_000))
      }
      const ids = found.map((m) => stringField(m, 'memory_id', 'id') ?? '').filter((id) => id !== '')
      for (const id of ids) recordCreated('memory', id, `${NAME.agent} run memory`)
      writeState({ memoryIds: ids })
      r.note(`memories from agent_run ${runId}: ${found.length} (${found.map((m) => `${String(m['status'])}: ${String(m['text'] ?? m['statement'] ?? '').slice(0, 100)}`).join(' | ') || 'none — the extractor kept nothing durable'})`)
      const extractor = reportLines('voc-memory-extractor', readState().windows?.['run']?.[0] ?? t0, Date.now())
      r.note(`voc-memory-extractor REPORT lines since the run started: ${extractor.length}`)
      expect(extractor.length).toBeGreaterThan(0)
    })

    await softStep(page, '04e-cancel-second-run', async (r) => {
      await page.goto(site(`/agents/${aid}?tab=runs`), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      const reused = readState().cancelRunId
      const attempt = reused === undefined ? await startAndCancelViaUi(page, r, aid) : null
      const runId = attempt?.runId ?? reused ?? ''
      const cancelStatus = attempt?.cancelStatus ?? null
      const cancelledAt = attempt?.cancelledAt ?? Date.now()
      if (attempt === null) r.note(`evidence for run ${runId}, cancelled by an earlier attempt of this step (no extra run)`)
      const run = await waitForRun(aid, runId, 90_000)
      await expectRunTouchedNoProject(r, aid, runId)
      const events = await allEvents(aid, runId)
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const execution = stepFunctionsExecution(executionArn(runId))
      const afterCancel = events.filter((e) => Date.parse(e.at) > Date.parse(String(run['finished_at'])))
      r.note(`run ${runId}: status=${String(run['status'])} finished=${String(run['finished_at'])} model_calls=${String(run['model_calls'])}`)
      r.note(`journal: ${events.map((e) => `#${e.seq} ${e.kind}${e.node_id === undefined ? '' : ` ${e.node_id}`} ${e.at.slice(11, 19)}`).join(' | ')}`)
      r.note(`SFN ${runId}: ${execution.status} after ${execution.durationMs ?? '?'}ms; states: ${execution.states.map((s) => `${s.name} ${s.ms ?? '?'}ms`).join(' > ')}`)
      r.note(`journal events recorded after the run was marked cancelled: ${afterCancel.length}`)
      saveJson('s2-run-cancelled.json', { run, events, execution, cancelStatus, cancelledAt: new Date(cancelledAt).toISOString() })
      expect.soft(cancelStatus === null || cancelStatus === 200, 'cancel answers 200').toBe(true)
      expect(run['status']).toBe('cancelled')
      expect.soft(execution.status, 'the execution is stopped (ABORTED)').toBe('ABORTED')
      // Stopped means stopped: nothing new in the journal 20 s later.
      const before = (await allEvents(aid, runId)).length
      await new Promise((resolve) => setTimeout(resolve, 20_000))
      const after = (await allEvents(aid, runId)).length
      r.note(`journal events ${before} -> ${after} over 20 s afterwards`)
      expect(after).toBe(before)
    })
    await context.close()
  })

  test('s2-05 duplicate/export/import, enable/disable, run history, e2e-user refused', async ({ browser }) => {
    test.setTimeout(300_000)
    const state = readState()
    const { savedDefinition, runId, cancelRunId } = state
    const { aid, wid, context, page } = await agentSession(browser, state)

    await softStep(page, '05a-export-ui', async (r) => {
      await page.goto(site(`/agents/${aid}?tab=workflow`), { waitUntil: 'domcontentloaded' })
      await settle(page, 800)
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Export' }).click()
      const file = await download
      const target = path.join(OUT_DIR, `s2-${file.suggestedFilename()}`)
      await file.saveAs(target)
      const exported: unknown = JSON.parse(fs.readFileSync(target, 'utf8'))
      const api = await apiCall('admin', 'GET', `/workflows/${wid}/export`)
      r.note(`Export downloaded ${file.suggestedFilename()}; GET /workflows/{id}/export -> ${api.status} in ${api.ms}ms; file == API: ${String(canonical(exported) === canonical(api.body))}`)
      const exportedDef = isRecord(exported) && Array.isArray(exported['nodes']) ? exported : record(exported, 'definition')
      r.note(`exported graph == saved graph: ${String(graphOf(exportedDef) === graphOf(savedDefinition))}`)
      expect(api.status).toBe(200)
      expect(canonical(exported)).toBe(canonical(api.body))
      expect(graphOf(exportedDef)).toBe(graphOf(savedDefinition))
    })

    await softStep(page, '05b-duplicate-and-import-api', async (r) => {
      const dup = await apiCall('admin', 'POST', `/workflows/${wid}/duplicate`, { name: NAME.duplicate })
      const dupWf = record(dup.body, 'workflow')
      const dupId = stringField(dupWf, 'workflow_id')
      if (dupId !== undefined) recordCreated('workflow', dupId, NAME.duplicate)
      r.note(`POST /workflows/{id}/duplicate -> ${dup.status} in ${dup.ms}ms id=${dupId ?? '?'} derived_from=${String(dupWf['derived_from'])}`)
      expect(dup.status).toBe(201)
      const exportBody = (await apiCall('admin', 'GET', `/workflows/${wid}/export`)).body
      const file = isRecord(exportBody) ? { ...exportBody, name: NAME.imported } : exportBody
      const imp = await apiCall('admin', 'POST', '/workflows/import', { definition: file })
      const impWf = record(imp.body, 'workflow')
      const impId = stringField(impWf, 'workflow_id')
      if (impId !== undefined) recordCreated('workflow', impId, NAME.imported)
      r.note(`POST /workflows/import -> ${imp.status} in ${imp.ms}ms id=${impId ?? '?'} derived_from=${String(impWf['derived_from'])} body=${imp.status >= 300 ? JSON.stringify(imp.body).slice(0, 300) : 'ok'}`)
      expect(imp.status).toBe(201)
      for (const id of [dupId, impId]) {
        if (id === undefined) continue
        const got = await apiCall('admin', 'GET', `/workflows/${id}`)
        const def = record(record(got.body, 'workflow'), 'definition')
        const sameGraph = graphOf(def) === graphOf(savedDefinition)
        r.note(`GET /workflows/${id} -> ${got.status} name=${String(def['name'])} same graph as the saved workflow: ${String(sameGraph)}`)
        expect(sameGraph).toBe(true)
      }
    })

    await softStep(page, '05c-enable-disable', async (r) => {
      await page.goto(site(`/agents/${aid}?tab=settings`), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      const toggle = page.getByRole('switch', { name: 'Enabled' })
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      const enabled = page.waitForResponse((res) => isApi(res, 'POST', new RegExp(`/agents/${aid}/enable$`)))
      await toggle.click()
      r.note(`POST /enable -> ${(await enabled).status()}`)
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      expect(record((await apiCall('admin', 'GET', `/agents/${aid}`)).body, 'agent')['enabled']).toBe(true)
      // Disable straight away: the schedule trigger must not fire a real scheduled run.
      const disabled = page.waitForResponse((res) => isApi(res, 'POST', new RegExp(`/agents/${aid}/disable$`)))
      await toggle.click()
      r.note(`POST /disable -> ${(await disabled).status()}`)
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      const after = record((await apiCall('admin', 'GET', `/agents/${aid}`)).body, 'agent')
      r.note(`GET /agents/{id} enabled=${String(after['enabled'])} (enabled for ~seconds; heartbeat is every 15 min)`)
      expect(after['enabled']).toBe(false)
    })

    await softStep(page, '05d-run-history', async (r) => {
      await page.goto(site(`/agents/${aid}?tab=runs`), { waitUntil: 'domcontentloaded' })
      await settle(page)
      const runs = page.getByRole('list', { name: 'Runs' }).getByRole('button')
      const listed = await apiCall('admin', 'GET', `/agents/${aid}/runs`)
      const expected = runLedger().filter((e) => e.kind === 'agent-run').map((e) => e.id)
      const listedIds = listOf(listed.body, 'items').map((x) => String(x['run_id']))
      r.note(`GET /agents/{id}/runs -> ${listed.status}: ${listOf(listed.body, 'items').map((x) => `${String(x['run_id'])}=${String(x['status'])}`).join(', ')}`)
      expect([...listedIds].sort()).toEqual([...new Set(expected)].sort())
      await expect(runs).toHaveCount(listedIds.length)
      expect([runId, cancelRunId].every((id) => id !== undefined && listedIds.includes(id))).toBe(true)
      await runs.nth(1).click()
      await expect(runs.nth(1)).toHaveAttribute('aria-current', 'true')
      await expect(page.locator('section[aria-label="Event log"] li').first()).toBeVisible()
      r.note(`older run selected; its graph + event log render (${await page.locator('section[aria-label="Event log"] li').count()} events)`)
    })

    await softStep(page, '05e-save-as-ui', async (r) => {
      await page.goto(site(`/agents/${aid}?tab=workflow`), { waitUntil: 'domcontentloaded' })
      await settle(page, 800)
      await page.getByRole('button', { name: 'Save as…' }).click()
      const dialog = dialogNamed(page, 'Save as a new workflow')
      await dialog.getByLabel('Workflow name').fill(NAME.savedAs)
      const created = page.waitForResponse((res) => isApi(res, 'POST', /\/workflows$/))
      const switched = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/agents/${aid}$`)), { timeout: 15_000 }).catch(() => null)
      await dialog.getByRole('button', { name: 'Save as…' }).click()
      const res = await created
      const newId = stringField(record(await jsonOf(res), 'workflow'), 'workflow_id')
      if (newId !== undefined) recordCreated('workflow', newId, NAME.savedAs)
      const sw = await switched
      r.note(`Save as -> POST /workflows ${res.status()} id=${newId ?? '?'}; agent switched (PUT /agents/{id}): ${sw === null ? 'no' : String(sw.status())}`)
      expect(res.status()).toBe(201)
      const agent = record((await apiCall('admin', 'GET', `/agents/${aid}`)).body, 'agent')
      r.note(`agent.workflow_id now ${String(agent['workflow_id'])}`)
    })
    await context.close()

    // ── e2e-user: every write refused, the UI read-only ───────────────────────
    const userContext = await contextFor(browser, 'user')
    const userPage = await userContext.newPage()
    await softStep(userPage, '05f-user-refused', async (r) => {
      const probes: Array<[string, string, unknown]> = [
        ['POST', '/agents', { name: `${E2E_PREFIX}${RUN_ID}-user-agent` }],
        ['PUT', `/agents/${aid}`, { description: 'user write attempt' }],
        ['POST', `/agents/${aid}/enable`, {}],
        ['POST', `/agents/${aid}/disable`, {}],
        ['POST', `/agents/${aid}/run`, {}],
        ['DELETE', `/agents/${aid}`, undefined],
        ['POST', '/workflows', { definition: SKELETON }],
        ['PUT', `/workflows/${wid}`, { definition: savedDefinition, expected_revision: 1 }],
        ['POST', `/workflows/${wid}/duplicate`, { name: `${E2E_PREFIX}${RUN_ID}-user-dup` }],
        ['POST', '/workflows/import', { definition: SKELETON }],
        ['POST', `/agents/${aid}/runs/${runId ?? 'ar_000000000000'}/cancel`, {}],
      ]
      const results: Array<{ call: string; status: number }> = []
      for (const [method, p, body] of probes) {
        const res: ApiResult = await apiCall('user', method, p, body)
        results.push({ call: `${method} ${p.replace(aid, '{agent}').replace(wid, '{wf}')}`, status: res.status })
      }
      r.note(results.map((x) => `${x.call} -> ${x.status}`).join('; '))
      saveJson('s2-user-refused.json', results)
      expect(results.filter((x) => x.status !== 403)).toEqual([])
      const reads = await apiCall('user', 'GET', `/agents/${aid}`)
      r.note(`user GET /agents/{id} -> ${reads.status}`)
      await userPage.goto(site('/agents'), { waitUntil: 'domcontentloaded' })
      await settle(userPage)
      await expect(userPage.getByRole('button', { name: 'New agent' })).toHaveCount(0)
      if (reads.status === 200) {
        await userPage.goto(site(`/agents/${aid}?tab=settings`), { waitUntil: 'domcontentloaded' })
        await settle(userPage)
        await expect(userPage.getByRole('switch', { name: 'Enabled' })).toBeDisabled()
        await expect(userPage.getByRole('button', { name: 'Archive' })).toHaveCount(0)
        await expect(userPage.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
        await userPage.goto(site(`/agents/${aid}?tab=runs`), { waitUntil: 'domcontentloaded' })
        await settle(userPage)
        await expect(userPage.getByRole('button', { name: 'Run now' })).toHaveCount(0)
        await userPage.goto(site(`/agents/${aid}?tab=workflow`), { waitUntil: 'domcontentloaded' })
        await settle(userPage, 800)
        const paletteButtons = userPage.getByRole('navigation', { name: 'Steps' }).getByRole('button')
        const total = await paletteButtons.count()
        const disabled = await paletteButtons.evaluateAll((els) => els.filter((el) => el instanceof HTMLButtonElement && el.disabled).length)
        r.note(`user editor: palette ${disabled}/${total} disabled; Save/Import buttons: ${await userPage.getByRole('button', { name: /^(Save|Import|Save as…)$/ }).count()}`)
        expect(disabled).toBe(total)
        await expect(userPage.getByRole('button', { name: /^(Save|Import|Save as…|Reset to template)$/ })).toHaveCount(0)
      }
    }, 'user')
    await userContext.close()
  })

  test('s2-99 cleanup: archive the agent and its workflows, forget run memories, delete conversations, prove it', async ({ browser }) => {
    test.setTimeout(240_000)
    const state = readState()
    const proof: Array<{ action: string; status: number; detail: string }> = []
    const ledger = runLedger()
    const context = await contextFor(browser, 'admin')
    const page = await context.newPage()
    await softStep(page, '99-cleanup', async (r) => {
      // Agents: no hard delete exists (DELETE /agents/{id} archives). Archive through the UI.
      for (const agent of ledger.filter((e) => e.kind === 'agent')) {
        const run = listOf((await apiCall('admin', 'GET', `/agents/${agent.id}/runs`)).body, 'items')
        for (const active of run.filter((x) => ['queued', 'running'].includes(String(x['status'])))) {
          const c = await apiCall('admin', 'POST', `/agents/${agent.id}/runs/${String(active['run_id'])}/cancel`, {})
          proof.push({ action: 'cancel leftover active run', status: c.status, detail: String(active['run_id']) })
        }
        await page.goto(site(`/agents/${agent.id}?tab=settings`), { waitUntil: 'domcontentloaded' })
        await settle(page, 500)
        const archived = page.waitForResponse((res) => isApi(res, 'DELETE', new RegExp(`/agents/${agent.id}$`)))
        await page.getByRole('button', { name: 'Archive' }).click()
        await dialogNamed(page, 'Archive this agent?').getByRole('button', { name: 'Archive', exact: true }).click()
        proof.push({ action: 'DELETE /agents/{id} (archive, via the UI)', status: (await archived).status(), detail: agent.id })
      }
      const listed = await apiCall('admin', 'GET', '/agents')
      const visible = listOf(listed.body, 'items').filter((a) => String(a['name'] ?? '').startsWith(`${E2E_PREFIX}${RUN_ID}-`))
      proof.push({ action: 'GET /agents (after)', status: listed.status, detail: `e2e agents listed: ${visible.length}` })
      const withArchived = await apiCall('admin', 'GET', '/agents?include_archived=true')
      const archivedRows = listOf(withArchived.body, 'items').filter((a) => String(a['name'] ?? '').startsWith(`${E2E_PREFIX}${RUN_ID}-`))
      proof.push({ action: 'GET /agents?include_archived=true (after)', status: withArchived.status, detail: archivedRows.map((a) => `${String(a['agent_id'])}: status=${String(a['status'])} enabled=${String(a['enabled'])}`).join('; ') })
      expect(visible).toEqual([])

      // Memories the run produced: forget (the memory table never deletes; forget tombstones).
      for (const id of state.memoryIds ?? []) {
        const f = await apiCall('admin', 'POST', `/memory/${encodeURIComponent(id)}/forget`, {})
        proof.push({ action: 'POST /memory/{id}/forget', status: f.status, detail: id })
      }
      for (const status of ['active', 'proposed']) {
        const res = await apiCall('admin', 'GET', `/memory?scope=company&status=${status}&limit=100`)
        const left = listOf(res.body, 'items').filter((m) => (state.memoryIds ?? []).includes(stringField(m, 'memory_id', 'id') ?? ''))
        proof.push({ action: `GET /memory?status=${status} (after)`, status: res.status, detail: `run memories still ${status}: ${left.length}` })
        expect(left).toEqual([])
      }

      // Assistant conversations: every one this run started (the stream tap and the save watcher
      // both record them), each deleted as its owner.
      for (const c of await deleteConversations(runConversations())) {
        proof.push({ action: `DELETE + GET /chat/conversations/{id} as ${c.owner}`, status: c.getStatus, detail: `${c.id}: delete ${c.deleteStatus}, get ${c.getStatus}` })
        expect.soft(c.getStatus).toBe(404)
      }

      // Projects a run created (QA 3.00.00 S1): read from each run's journal again (recording is
      // idempotent, and a run cut short still journals its creation), then deleted from the ledger.
      // Soft: a leftover must not keep the workflows below from being archived.
      const agentId = state.agentId
      const runs = agentId === undefined ? [] : ledger.filter((e) => e.kind === 'agent-run')
      for (const runEntry of runs) {
        const found = await recordRunProjects(agentId ?? '', runEntry.id).catch((error: unknown) => {
          proof.push({ action: 'GET run journal (projects)', status: 0, detail: `${runEntry.id}: ${String(error)}` })
          return { created: [], reused: [] }
        })
        proof.push({ action: 'run journal: projects', status: 0, detail: `${runEntry.id}: created ${found.created.join(',') || 'none'}; reused ${found.reused.join(',') || 'none'}` })
      }
      for (const p of await deleteProjects(runLedger().filter((e) => e.kind === 'project'))) {
        proof.push({ action: 'DELETE + GET /projects/{id}', status: p.getStatus, detail: `${p.id} (${p.name}): delete ${p.deleteStatus}, get ${p.getStatus}` })
        expect.soft(p.getStatus, `project ${p.id} left behind`).toBe(404)
      }

      // Workflows: archived from the Workflow library on /agents (DELETE /workflows/{id} archives),
      // after their agents, since a workflow an active agent runs answers 409. The built-in
      // offers no Archive and its DELETE is a 409. Runs have no delete route and stay.
      const runWorkflows = ledger.filter((e) => e.kind === 'workflow').map((e) => e.id)
      for (const p of await archiveWorkflowsInLibrary(page, runWorkflows)) {
        proof.push({ action: `DELETE /workflows/{id} (archive, via ${p.via})`, status: p.status, detail: `${p.id} ${p.name}` })
        if (p.via !== 'not listed') expect(p.status, `archive ${p.id}`).toBe(200)
      }
      proof.push({ action: 'Workflow library: no Archive on the built-in; DELETE /workflows/wf_default', status: await expectBuiltinNotArchivable(page), detail: 'expect 409' })
      const wfs = await apiCall('admin', 'GET', '/workflows')
      const e2eWfs = listOf(wfs.body, 'items').filter((w) => runWorkflows.includes(String(w['workflow_id'])))
      proof.push({ action: 'GET /workflows (after)', status: wfs.status, detail: `this run's workflows still listed: ${e2eWfs.length}` })
      expect(e2eWfs).toEqual([])
      for (const runEntry of ledger.filter((e) => e.kind === 'agent-run')) {
        const arn = executionArn(runEntry.id)
        let status = 'UNKNOWN'
        try { status = stepFunctionsExecution(arn).status } catch { status = 'not found' }
        proof.push({ action: 'stepfunctions describe-execution (after)', status: 0, detail: `${runEntry.id}: ${status}` })
        expect(status).not.toBe('RUNNING')
      }
      const s1 = await apiCall('admin', 'GET', '/agents')
      r.note(`agents listed after cleanup: ${listOf(s1.body, 'items').length}`)
      for (const p of proof) r.note(`${p.action} -> ${p.status} ${p.detail}`)
    })
    saveJson('s2-cleanup-proof.json', { at: new Date().toISOString(), runId: RUN_ID, ledger, proof })
    await context.close()
  })
})
