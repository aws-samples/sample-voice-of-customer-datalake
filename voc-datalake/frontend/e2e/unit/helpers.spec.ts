/**
 * The suite-side fixes of QA 2.14.00, offline:
 * - a dialog is found by name, so an open assistant panel (also a dialog) is never picked (s3-07/08/10/11);
 * - saved sessions lose the persisted UI state, so a panel left open does not open in the next spec;
 * - every conversation a run starts reaches the ledger from the stream request, saved or not;
 * - the ledger records an entity once even when several sources see it.
 * And the P2 helpers: error-state injection (lib/inject.ts), MCP answers (lib/mcp.ts),
 * the ledger's owned kinds (tokens, memories).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { PERSISTED_UI_KEYS, browserCreated, streamThreadId, withoutPersistedUi } from '../lib/context'
import { SAFE_RUN_STEP_TYPES, journalEventOf, runProjectLabel, runProjects, runTargetProblems } from '../lib/agentRuns'
import { avatarKeyOfUrl, avatarKeysOf, isAvatarKeyOf } from '../lib/avatars'
import { boxOf, expectTravel, intersects, settledBoxOf, travelFrom } from '../lib/geometry'
import { runConversations } from '../lib/runCleanup'
import { dialogNamed, unnamedDialogLookups } from '../lib/dialogs'
import { headWords, lastAssistantText, plainText, runStatusOf } from '../lib/assistantHealth'
import { ENTITY_KINDS, readLedger, recordCreated } from '../lib/ledger'
import { INJECTED_BODY, injectFailure, isTimeout, matchesInjection, withoutInjected, type InjectionSpec } from '../lib/inject'
import { readMcpAnswer } from '../lib/mcp'
import { MOCK_SPECS, MOCK_SPEC_NAMES, OUT_DIR, RUN_PREFIX, apiUrl } from '../lib/env'
import {
  ENDPOINT_DEFAULT, breachOf, budgetMode, endpointBudget, enforceBudgets, screenDclBudget, screenSlowestCallBudget, slowestApiCall,
} from '../lib/budgets'
import { keyPaths, overflowsHorizontally, rawKeysIn, themeAttributesMatch } from '../lib/mode'
import { designAudit, offPaletteFills } from '../lib/design'
import { apiGetMatcher } from '../lib/network'

test('raw i18n keys: an exact key path or a namespace:key is found, prose, hosts and versions are not', () => {
  const keys = new Set(keyPaths({ panel: { stillGenerating: 'Still generating…', nested: { deep: 'x' } }, title: 'T' }))
  expect([...keys]).toStrictEqual(['panel.stillGenerating', 'panel.nested.deep', 'title'])
  const text = 'Hello panel.stillGenerating and (panel.nested.deep). See www.example.com v2.17.0, assistant:panel.foo, foo:bar.baz, title.'
  expect(rawKeysIn(text, keys, ['assistant']).sort()).toStrictEqual(['assistant:panel.foo', 'panel.nested.deep', 'panel.stillGenerating'])
  expect(rawKeysIn('Still generating… 2.17.0 example.com', keys, ['assistant'])).toStrictEqual([])
})

test('overflow is a scroll width past the viewport by more than a pixel; the theme is both attributes', () => {
  expect(overflowsHorizontally({ scrollWidth: 391, clientWidth: 390 })).toBe(false)
  expect(overflowsHorizontally({ scrollWidth: 392, clientWidth: 390 })).toBe(true)
  expect(themeAttributesMatch({ dataMode: 'light', dataTheme: 'kiro-light' }, 'light')).toBe(true)
  expect(themeAttributesMatch({ dataMode: 'light', dataTheme: 'kiro-dark' }, 'light')).toBe(false)
  expect(themeAttributesMatch({ dataMode: null, dataTheme: null }, 'dark')).toBe(false)
})

test('the off-palette check finds an app-coloured blue-500, marks inline user colours, passes Kiro tokens in any syntax', async ({ page }) => {
  await page.setContent(`
    <style>.blue { background: #3b82f6 } .ok { background: oklch(0.6 0.25 295) } .tint { background: rgba(59,130,246,.2) }</style>
    <div class="blue" style="width:10px;height:10px"></div>
    <div id="swatch" style="width:10px;height:10px;background-color:#ef4444"></div>
    <div style="width:10px;height:10px;background-color:#8e48ff"></div>
    <div style="width:10px;height:10px;background:color(srgb 0.098 0.086 0.114)"></div>
    <div class="tint" style="width:10px;height:10px"></div>`)
  const fills = await offPaletteFills(page)
  expect(fills).toContainEqual({ selector: 'div.blue', color: 'rgb(59, 130, 246)', inline: false })
  expect(fills).toContainEqual({ selector: 'div#swatch', color: 'rgb(239, 68, 68)', inline: true })
  // #8e48ff (accent) and #19161d written as color(srgb …) are tokens; a 20 % tint is not "solid".
  expect(fills.map((f) => f.color)).not.toContain('rgb(142, 72, 255)')
  expect(fills.map((f) => f.color)).not.toContain('rgb(25, 22, 29)')
  expect(fills.filter((f) => f.selector === 'div.tint')).toStrictEqual([])
})

test('an API route matcher is exact on the path and ignores the query', () => {
  const matches = apiGetMatcher('/feedback-forms')
  expect(matches(new URL(`${apiUrl()}/feedback-forms?include=stats`))).toBe(true)
  expect(matches(new URL(`${apiUrl()}/feedback-forms/form_1`))).toBe(false)
  expect(matches(new URL('https://elsewhere.example/v1/feedback-forms'))).toBe(false)
})

test('a dialog is found by name, not position: an open assistant panel is never the match', async ({ page }) => {
  await page.setContent(`
    <div role="dialog" aria-modal="true" aria-label="Remix Documents"><button>Next</button></div>
    <section role="dialog" aria-labelledby="t"><h2 id="t">AI assistant</h2><button>Send</button></section>`)
  await expect(dialogNamed(page, 'Remix Documents').getByRole('button')).toHaveText('Next')
  await expect(dialogNamed(page, /^Remix/).getByRole('button')).toHaveText('Next')
  // An exact name: a dialog whose name merely contains it is not a match.
  await expect(dialogNamed(page, 'Remix')).toHaveCount(0)
})

test('saved sessions keep the login and drop the persisted UI state', () => {
  const state = {
    cookies: [],
    origins: [{
      origin: 'https://site.example',
      localStorage: [
        { name: 'voc-auth', value: '{"state":{}}' },
        { name: 'voc-config', value: '{}' },
        { name: 'voc-assistant-ui', value: '{"state":{"open":true}}' },
        { name: 'voc-manual-import', value: '{}' },
      ],
    }],
  }
  expect(withoutPersistedUi(state)).toStrictEqual({
    cookies: [],
    origins: [{ origin: 'https://site.example', localStorage: [{ name: 'voc-auth', value: '{"state":{}}' }, { name: 'voc-config', value: '{}' }] }],
  })
  expect(PERSISTED_UI_KEYS).toContain('voc-assistant-ui')
  // The launcher's dragged position must not carry from one spec into the next.
  expect(PERSISTED_UI_KEYS).toContain('voc-assistant-bubble')
  expect(withoutPersistedUi('not a state')).toBe('not a state')
})

const request = (method: string, url: string, body: string | null) => ({ method: () => method, url: () => url, postData: () => body })

test('the conversation id of every run comes from the stream request', () => {
  const stream = `${apiUrl()}/chat/stream`
  expect(streamThreadId(request('POST', stream, JSON.stringify({ threadId: 'conv_1', runId: 'r', messages: [] })))).toBe('conv_1')
  expect(streamThreadId(request('GET', stream, null))).toBeNull()
  expect(streamThreadId(request('POST', `${apiUrl()}/chat/conversations/conv_1`, '{"threadId":"x"}'))).toBeNull()
  expect(streamThreadId(request('POST', 'https://elsewhere.example/v1/chat/stream', '{"threadId":"x"}'))).toBeNull()
  expect(streamThreadId(request('POST', stream, 'not json'))).toBeNull()
  expect(streamThreadId(request('POST', stream, '{"threadId":""}'))).toBeNull()
})

test('an entity seen by the stream and by its save is recorded once', () => {
  fs.rmSync(path.join(OUT_DIR, 'created.json'), { force: true })
  recordCreated('conversation', 'conv_1', 'assistant stream conv_1', 'user')
  recordCreated('conversation', 'conv_1', 'e2e saved conversation', 'user')
  recordCreated('conversation', 'conv_2', 'assistant stream conv_2')
  expect(readLedger().map((e) => [e.id, e.name, e.role ?? null])).toStrictEqual([
    ['conv_1', 'assistant stream conv_1', 'user'],
    ['conv_2', 'assistant stream conv_2', null],
  ])
})

// ------------------------------------------------- dialog lookup guard ----

// fileURLToPath, not URL.pathname: the latter keeps %20 for paths with spaces (as in lib/env.ts).
const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every spec and helper the suite runs (unit/ itself holds the patterns as test data). */
function suiteSources(): string[] {
  return ['tests', 'lib'].flatMap((dir) => fs.readdirSync(path.join(E2E_ROOT, dir))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(dir, file)))
}

test('the dialog guard flags a positional or unnamed lookup and allows counting all of them', () => {
  const flagged = [
    "page.getByRole('dialog').last()",
    'page.getByRole("dialog").first().click()',
    "page.getByRole('dialog').nth(1)",
    "page.getByRole('dialog').or(page.locator('[role=menu]')).last()",
    "const d = page.getByRole('dialog')\nawait d.getByRole('button').click()",
    "page.getByRole( 'dialog' )\n  .last()",
  ]
  for (const source of flagged) expect(unnamedDialogLookups(source), source).toHaveLength(1)
  const allowed = [
    "await page.getByRole('dialog').count()",
    "await expect(page.getByRole('dialog')).toHaveCount(0)",
    "await expect(page.getByRole('dialog')).not.toHaveCount(2)",
    "page.getByRole('dialog', { name: 'Delete Project', exact: true })",
    "dialogNamed(page, 'Import Persona').last()",
    "// the old `getByRole('dialog').last()` matched the panel",
    "/* getByRole('dialog').first() */ const x = 1",
    "const url = 'https://site.example' // getByRole('dialog').last()",
  ]
  for (const source of allowed) expect(unnamedDialogLookups(source), source).toEqual([])
  expect(unnamedDialogLookups("a\nb\n  page.getByRole('dialog').last()")).toEqual(["3: page.getByRole('dialog').last()"])
})

test('no spec or helper looks a dialog up by position (verify F3): use dialogNamed', () => {
  const sources = suiteSources()
  expect(sources.length).toBeGreaterThan(10)
  const offenders = sources.flatMap((file) =>
    unnamedDialogLookups(fs.readFileSync(path.join(E2E_ROOT, file), 'utf8')).map((hit) => `${file}:${hit}`))
  expect(offenders).toEqual([])
})

// ----------------------------------------------- assistant session reads ----

test('a stored session is read leniently: run status and the last assistant answer', () => {
  const session = {
    runStatus: 'finished',
    messages: [
      { id: 'u1', role: 'user', content: 'question' },
      { id: 'a1', role: 'assistant', content: 'first answer' },
      { id: 't1', role: 'tool', content: '{"rows":1}' },
      { id: 'a2', role: 'assistant', content: '' },
      { id: 'a3', role: 'assistant', content: 'final **answer**' },
      'not a message',
    ],
  }
  expect(runStatusOf(session)).toBe('finished')
  expect(runStatusOf({ runStatus: 'done' })).toBeNull()
  expect(runStatusOf(null)).toBeNull()
  expect(lastAssistantText(session)).toBe('final **answer**')
  expect(lastAssistantText({ messages: [{ role: 'assistant', content: 7 }] })).toBe('')
  expect(lastAssistantText({ messages: 'x' })).toBe('')
})

test('markdown is compared as the words a reader sees', () => {
  const md = '## Themes\n\n- **Shipping** is slow, see [the post](https://x.example/p)\n\n| a | b |\n```js\ncode()\n```\nDone.'
  expect(plainText(md)).toBe('Themes Shipping is slow, see the post a b Done.')
  expect(headWords(md, 3)).toBe('Themes Shipping is')
})

test('latency budgets: mode from E2E_BUDGETS, per-route overrides, and the slowest API call', () => {
  expect(budgetMode(undefined)).toBe('hard')
  expect(budgetMode('')).toBe('hard')
  expect(budgetMode(' Soft ')).toBe('soft')
  expect(budgetMode('off')).toBe('off')
  expect(() => budgetMode('loose')).toThrow(/E2E_BUDGETS/)

  expect(endpointBudget('/feedback?days=30&limit=20')).toEqual(ENDPOINT_DEFAULT)
  expect(endpointBudget('/sources/status').p95Ms).toBeGreaterThan(ENDPOINT_DEFAULT.p95Ms)
  expect(endpointBudget('/users').p95Ms).toBeGreaterThan(ENDPOINT_DEFAULT.p95Ms)
  // `/users/{name}/category-access` is not `/users`.
  expect(endpointBudget('/users/e2e-admin/category-access')).toEqual(ENDPOINT_DEFAULT)
  expect(endpointBudget('/projects/proj_1').p95Ms).toBeGreaterThan(ENDPOINT_DEFAULT.p95Ms)
  expect(endpointBudget('/projects/proj_1/members')).toEqual(ENDPOINT_DEFAULT)
  expect(screenDclBudget('login').p95Ms).toBeGreaterThan(screenDclBudget('dashboard').p95Ms)
  expect(screenSlowestCallBudget('dashboard').source).not.toBe('')

  const budget = { p95Ms: 100, source: 'unit' }
  expect(breachOf('x', 100, budget)).toBeNull()
  expect(breachOf('x', null, budget)).toBeNull()
  expect(breachOf('x', 101, budget)?.measuredMs).toBe(101)

  const calls = [
    { method: 'GET', path: '/v1/feedback', host: 'api.unit.example', durationMs: 900 },
    { method: 'POST', path: '/v1/chat/stream', host: 'api.unit.example', durationMs: 30_000 },
    { method: 'GET', path: '/assets/app.js', host: 'site.unit.example', durationMs: 5_000 },
    { method: 'GET', path: '/v1/projects', host: 'api.unit.example', durationMs: null },
  ]
  expect(slowestApiCall(calls, 'api.unit.example')).toEqual({ label: 'GET /v1/feedback', ms: 900 })
  expect(slowestApiCall([], 'api.unit.example')).toBeNull()
})

test('latency budgets: soft annotates, hard fails, off ignores', () => {
  const breach = breachOf('GET /slow', 5_000, { p95Ms: 1_000, source: 'unit' })
  const info = test.info()
  const before = info.annotations.length
  enforceBudgets(info, [breach, null], 'soft')
  expect(info.annotations.slice(before)).toEqual([{ type: 'budget', description: 'GET /slow: 5000 ms > p95 budget 1000 ms (unit)' }])
  enforceBudgets(info, [breach], 'off')
  expect(info.annotations.length).toBe(before + 1)
  enforceBudgets(info, [null], 'hard')
  expect(() => enforceBudgets(info, [breach], 'hard')).toThrow(/latency budgets/)
})

// ------------------------------------------------ error-state injection ----

test('an injection matches its method, API origin, path and query only', () => {
  const api = 'https://api.unit.example/v1'
  const spec: InjectionSpec = { method: 'GET', path: /\/memory$/, query: /scope=personal/, failure: { status: 500 } }
  expect(matchesInjection(spec, 'GET', `${api}/memory?scope=personal`, api)).toBe(true)
  expect(matchesInjection(spec, 'get', `${api}/memory?scope=personal`, api)).toBe(true)
  expect(matchesInjection(spec, 'POST', `${api}/memory?scope=personal`, api)).toBe(false)
  expect(matchesInjection(spec, 'GET', `${api}/memory?scope=company`, api)).toBe(false)
  expect(matchesInjection(spec, 'GET', `${api}/memory/review`, api)).toBe(false)
  expect(matchesInjection(spec, 'GET', 'https://site.unit.example/v1/memory?scope=personal', api)).toBe(false)
  // A CORS preflight is never failed, whatever the spec says.
  expect(matchesInjection({ path: /\/memory$/, failure: { status: 500 } }, 'OPTIONS', `${api}/memory`, api)).toBe(false)
  expect(matchesInjection({ path: /\/memory$/, failure: { timeout: true } }, 'DELETE', `${api}/memory`, api)).toBe(true)
})

test('withoutInjected drops exactly the problems the injection caused', () => {
  const status: InjectionSpec = { method: 'GET', path: /\/projects$/, failure: { status: 500 } }
  const timeout: InjectionSpec = { path: /\/memory$/, failure: { timeout: true } }
  const problems = [
    'GET /v1/projects -> 500',
    'GET /v1/projects -> 502',
    'POST /v1/projects -> 500',
    'GET /v1/projects/p1 -> 500',
    'GET /v1/memory failed: net::ERR_TIMED_OUT',
    'GET /v1/memory -> 500',
    'pageerror: boom',
    'route error boundary rendered',
  ]
  expect(withoutInjected(problems, status, timeout)).toEqual([
    'GET /v1/projects -> 502',
    'POST /v1/projects -> 500',
    'GET /v1/projects/p1 -> 500',
    'GET /v1/memory -> 500',
    'pageerror: boom',
    'route error boundary rendered',
  ])
  expect(withoutInjected(problems)).toEqual(problems)
  expect(isTimeout(timeout.failure)).toBe(true)
  expect(isTimeout(status.failure)).toBe(false)
})

test('an injected status reaches the page with the API error body and CORS headers', async ({ page }) => {
  // A page on the API's own origin, so the fetch needs no network: the route answers it.
  await page.route(`${apiUrl()}/`, (route) => route.fulfill({ contentType: 'text/html', body: '<p>unit</p>' }))
  await page.goto(`${apiUrl()}/`)
  const injected = await injectFailure(page, { method: 'GET', path: /\/memory\/review$/, failure: { status: 503 } })
  const answer = await page.evaluate(async (url) => {
    const response = await fetch(url)
    const body: unknown = await response.json()
    return { status: response.status, body }
  }, `${apiUrl()}/memory/review`)
  expect(answer).toStrictEqual({ status: 503, body: INJECTED_BODY })
  expect(injected.hits()).toBe(1)
  await injected.remove()
  const timedOut = await injectFailure(page, { path: /\/memory$/, failure: { timeout: true } })
  const failed = await page.evaluate(async (url) => fetch(url).then(() => 'answered', () => 'failed'), `${apiUrl()}/memory`)
  expect(failed).toBe('failed')
  expect(timedOut.hits()).toBe(1)
})

// ------------------------------------------------ MCP answers and the ledger ----

test('an MCP answer is read leniently: tools, the JSON-RPC error code, the challenge', () => {
  expect(readMcpAnswer(200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a' }, { name: 'b' }] } }, null))
    .toStrictEqual({ status: 200, toolCount: 2, errorCode: null, wwwAuthenticate: null })
  expect(readMcpAnswer(401, { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Unauthorized' } }, 'Bearer realm="voc-mcp-global"'))
    .toStrictEqual({ status: 401, toolCount: null, errorCode: -32001, wwwAuthenticate: 'Bearer realm="voc-mcp-global"' })
  expect(readMcpAnswer(502, null, null)).toStrictEqual({ status: 502, toolCount: null, errorCode: null, wwwAuthenticate: null })
  expect(readMcpAnswer(200, { result: { tools: 'x' } }, null).toolCount).toBeNull()
})

test('the ledger keeps tokens and memories with their owner, and drops unknown kinds', () => {
  const file = path.join(OUT_DIR, 'created.json')
  fs.rmSync(file, { force: true })
  recordCreated('token', 'tok_1', 'e2e-unit-1-connect', 'user')
  recordCreated('memory', 'mem_1', 'e2e-unit-1-memory', 'admin')
  const written: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify([...(Array.isArray(written) ? written : []), { kind: 'spaceship', id: 'x', name: 'e2e-unit-1-x' }]))
  expect(readLedger().map((e) => [e.kind, e.id, e.role ?? null])).toStrictEqual([
    ['token', 'tok_1', 'user'],
    ['memory', 'mem_1', 'admin'],
  ])
  expect(ENTITY_KINDS).toEqual(expect.arrayContaining(['agent', 'workflow', 'token', 'memory']))
})

// ------------------------------------------------------ one mock switch ----

/** The suite's own sources plus its Playwright configs (where a second switch would also hide). */
function sourcesAndConfigs(): string[] {
  const configs = fs.readdirSync(E2E_ROOT).filter((file) => /^playwright\..*\.ts$/.test(file))
  return [...suiteSources(), ...configs]
}

const readsMockEnv = /process\.env(?:\[['"]E2E_MOCK['"]\]|\.E2E_MOCK)/

test('E2E_MOCK is read in exactly one place: MOCK in lib/env.ts', () => {
  const readers = sourcesAndConfigs().filter((file) => readsMockEnv.test(fs.readFileSync(path.join(E2E_ROOT, file), 'utf8')))
  expect(readers).toStrictEqual([path.join('lib', 'env.ts')])
})

test('there is one mock runner: no separate playwright.mock.config.ts beside playwright.config.ts', () => {
  expect(fs.existsSync(path.join(E2E_ROOT, 'playwright.mock.config.ts'))).toBe(false)
})

test('every spec that branches on MOCK runs under E2E_MOCK, and every listed mock spec exists', () => {
  const specs = fs.readdirSync(path.join(E2E_ROOT, 'tests')).filter((file) => file.endsWith('.spec.ts'))
  // The design track has its own mock projects (playwright.design.config.ts), the ops look its own config.
  const ownRunner = (file: string): boolean => file.startsWith('design-') || file.startsWith('ops-')
  const branching = specs.filter((file) => !ownRunner(file)
    && /import \{[^}]*\bMOCK\b[^}]*\} from '\.\.\/lib\/env'/.test(fs.readFileSync(path.join(E2E_ROOT, 'tests', file), 'utf8')))
  expect(branching.length).toBeGreaterThan(0)
  expect(branching.filter((file) => !MOCK_SPECS.test(`tests/${file}`))).toStrictEqual([])
  expect(MOCK_SPEC_NAMES.filter((name) => !specs.includes(`${name}.spec.ts`))).toStrictEqual([])
  // Whole names only: listing `prioritization` must not admit another spec that merely starts with it.
  expect(MOCK_SPECS.test('tests/prioritization.spec.ts')).toBe(true)
  expect(MOCK_SPECS.test('tests/prioritization-board.spec.ts')).toBe(false)
  expect(MOCK_SPECS.test('tests/writes.spec.ts')).toBe(false)
})

// modals.spec `assistant-sessions-drawer` on the dev mock: the mock's one seeded
// session gives the drawer exactly three Tab stops, so the focus audit's three
// Tabs all landed inside it and its closing Escape closed the drawer under test.
test('the design audit leaves an open overlay open (it never presses Escape)', async ({ page }) => {
  await page.setContent(`
    <aside aria-label="Past conversations">
      <button>Why are deliveries late?</button><button>Delete</button><button>Close</button>
    </aside>
    <script>
      // Escape closes it wherever focus is (the drawer's own handler fires once Tab has
      // walked into it, which is where the audit's three Tabs ended up on the mock).
      const drawer = document.querySelector('aside')
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') drawer.remove() })
      drawer.querySelector('button').focus()
    </script>`)

  const audit = await designAudit(page)

  // The audit did walk the overlay's buttons…
  expect(audit.focus.map((stop) => stop.element)).toContain('button "Close"')
  // …and left it open.
  await expect(page.getByRole('complementary', { name: 'Past conversations' })).toBeVisible()
})

// ------------------------------- QA 3.00.00 verify: s2 / s3 / F5 / F6 spec fixes ----

test('S1: a run is refused unless the agent runs its saved e2e workflow with safe steps only', () => {
  const target = { workflowId: 'wf_e2e', workflowName: 'e2e-unit-1-wf' }
  const agent = { agent: { agent_id: 'ag_1', workflow_id: 'wf_e2e' } }
  const saved = {
    workflow: {
      workflow_id: 'wf_e2e',
      definition: { name: 'e2e-unit-1-wf', nodes: ['start', 'aggregate_reviews', 'custom_llm', 'end'].map((type, i) => ({ id: `n${i}`, type })) },
    },
  }
  expect(runTargetProblems(agent, saved, target)).toStrictEqual([])
  // What production ran in 3.00.00: the save never landed, so the agent's template copy
  // (the built-in's graph, its own name) was still there, with its project steps.
  const templateCopy = {
    workflow: {
      workflow_id: 'wf_e2e',
      definition: { name: 'Research → PR/FAQ', nodes: [{ type: 'start' }, { type: 'aggregate_reviews' }, { type: 'select_or_create_project' }, { type: 'write_prfaq' }, { type: 'persona_review' }, { type: 'end' }] },
    },
  }
  const problems = runTargetProblems(agent, templateCopy, target)
  expect(problems).toHaveLength(2)
  expect(problems[0]).toMatch(/save did not land/)
  expect(problems[1]).toBe('steps a run must not execute: select_or_create_project, write_prfaq, persona_review')
  // An agent pointed at another workflow, an error body, an empty graph: all refused.
  expect(runTargetProblems({ agent: { workflow_id: 'wf_default' } }, saved, target)).toStrictEqual(['the agent runs workflow wf_default, not wf_e2e'])
  expect(runTargetProblems({ message: 'Not found' }, { message: 'Not found' }, target).length).toBeGreaterThanOrEqual(3)
  expect(runTargetProblems(agent, { workflow: { workflow_id: 'wf_e2e', definition: { name: 'e2e-unit-1-wf', nodes: [] } } }, target))
    .toStrictEqual(['the workflow has no steps'])
  expect(SAFE_RUN_STEP_TYPES).not.toContain('select_or_create_project')
})

test('S1: the projects a run created come from its journal; a reused project is never recorded', () => {
  const events = [
    { seq: 1, kind: 'node_started', node_id: 'project', summary: 'Choosing a project' },
    { seq: 2, kind: 'node_finished', node_id: 'project', summary: 'Created project proj_new for category checkout', ref: { project_id: 'proj_new' } },
    { seq: 3, kind: 'node_finished', node_id: 'handoff', summary: 'Handed off project proj_new', ref: { project_id: 'proj_new' } },
    { seq: 4, kind: 'node_finished', node_id: 'project2', summary: 'Reusing project proj_real: it fits', ref: { project_id: 'proj_real' } },
    // The summary and the ref disagree: neither alone is trusted.
    { seq: 5, kind: 'node_finished', summary: 'Created project proj_x for category all', ref: { project_id: 'proj_y' } },
    { seq: 6, kind: 'node_failed', summary: 'Created project proj_z', ref: { project_id: 'proj_z' } },
    'junk', null,
  ].map(journalEventOf)
  expect(runProjects(events)).toStrictEqual({ created: ['proj_new'], reused: ['proj_real'] })
  expect(runProjects([])).toStrictEqual({ created: [], reused: [] })
  // Its ledger label is this run's e2e name, so the shared cleanup's name check admits it.
  expect(runProjectLabel('ar_1').startsWith(RUN_PREFIX)).toBe(true)
})

test('assistant and UI creates reach the ledger from the browser response, whatever the model named them', () => {
  const api = apiUrl()
  expect(browserCreated('POST', `${api}/projects`, 201, { project: { project_id: 'proj_1', name: 'Zebrafin Aquarium Hub' } }))
    .toStrictEqual([{ kind: 'project', id: 'proj_1', name: `${RUN_PREFIX}project-via-browser Zebrafin Aquarium Hub` }])
  // A spec's own e2e name is kept as is, so its by-name lookups still find the entry.
  expect(browserCreated('POST', `${api}/projects`, 200, { project: { project_id: 'proj_2', name: `${RUN_PREFIX}s3-project` } }))
    .toStrictEqual([{ kind: 'project', id: 'proj_2', name: `${RUN_PREFIX}s3-project` }])
  // An agent's template copy is recorded with it; the built-in never is.
  expect(browserCreated('POST', `${api}/agents`, 201, { agent: { agent_id: 'ag_1', name: `${RUN_PREFIX}agent`, workflow_id: 'wf_copy' } }))
    .toStrictEqual([{ kind: 'agent', id: 'ag_1', name: `${RUN_PREFIX}agent` }, { kind: 'workflow', id: 'wf_copy', name: `${RUN_PREFIX}agent workflow` }])
  expect(browserCreated('POST', `${api}/agents`, 201, { agent: { agent_id: 'ag_2', name: `${RUN_PREFIX}a`, workflow_id: 'wf_default' } })).toHaveLength(1)
  expect(browserCreated('POST', `${api}/workflows/wf_1/duplicate`, 201, { workflow: { workflow_id: 'wf_2', name: 'copy' } })[0]?.kind).toBe('workflow')
  expect(browserCreated('POST', `${api}/feedback-forms`, 201, { form: { form_id: 'f_1', name: 'x' } })[0]?.id).toBe('f_1')
  // Not creates: another origin, a failure, an update, a save of an existing scraper, a nested project route.
  expect(browserCreated('POST', 'https://elsewhere.example/v1/projects', 201, { project: { project_id: 'p' } })).toStrictEqual([])
  expect(browserCreated('POST', `${api}/projects`, 409, { project: { project_id: 'p' } })).toStrictEqual([])
  expect(browserCreated('PUT', `${api}/projects`, 200, { project: { project_id: 'p' } })).toStrictEqual([])
  expect(browserCreated('POST', `${api}/scrapers`, 200, { scraper: { id: 's' } })).toStrictEqual([])
  expect(browserCreated('POST', `${api}/projects/p1/personas/generate`, 202, { job_id: 'j' })).toStrictEqual([])
  expect(browserCreated('POST', `${api}/projects`, 201, 'not json')).toStrictEqual([])
})

test('S3: cleanup takes every conversation of this run from the ledger, whatever its label', () => {
  fs.rmSync(path.join(OUT_DIR, 'created.json'), { force: true })
  recordCreated('project', 'proj_1', `${RUN_PREFIX}s3-project`)
  recordCreated('conversation', 'conv_stream', 'assistant stream conv_stream')
  recordCreated('conversation', 'conv_user', 'assistant stream conv_user', 'user')
  recordCreated('conversation', 'conv_turn', `${RUN_PREFIX}s3-project 05a`)
  // The 3.00.00 filter (`e.name.startsWith(PROJECT)`) kept one of the three.
  expect(runConversations().map((e) => [e.id, e.role ?? 'admin'])).toStrictEqual([
    ['conv_stream', 'admin'], ['conv_user', 'user'], ['conv_turn', 'admin'],
  ])
})

test('S4: the avatar proof reads the content-addressed layout and sees a leftover', () => {
  const listed = [
    'avatars/persona_1/0123456789abcdef01234567.jpeg', // current layout
    'avatars/persona_1.png', // legacy flat
    'avatars/persona_10/aaaaaaaaaaaaaaaaaaaaaaaa.jpeg', // another persona sharing the prefix
    'avatars/persona_1/nested/deeper.jpeg', // not an avatar key
    'avatars/persona_2/bbbbbbbbbbbbbbbbbbbbbbbb.png',
  ]
  expect(avatarKeysOf(['persona_1'], listed)).toStrictEqual(['avatars/persona_1.png', 'avatars/persona_1/0123456789abcdef01234567.jpeg'])
  expect(avatarKeysOf(['persona_2', 'persona_3'], listed)).toStrictEqual(['avatars/persona_2/bbbbbbbbbbbbbbbbbbbbbbbb.png'])
  expect(avatarKeysOf([''], listed)).toStrictEqual([])
  expect(isAvatarKeyOf('avatars/persona_1/', 'persona_1')).toBe(false)
  // The key a persona row points at is its signed CDN path.
  expect(avatarKeyOfUrl('https://d1.cloudfront.net/avatars/persona_1/0123456789abcdef01234567.jpeg?Expires=1&Signature=x'))
    .toBe('avatars/persona_1/0123456789abcdef01234567.jpeg')
  expect(avatarKeyOfUrl('https://d1.cloudfront.net/prototypes/x.html')).toBeNull()
  expect(avatarKeyOfUrl('')).toBeNull()
})

test('S5: the launcher travel is whole pixels, and a reset is exactly zero', () => {
  const home = { x: 1360, y: 820, width: 48, height: 48 }
  expect(travelFrom(home, { ...home, x: 1296.4, y: 788.2 })).toStrictEqual({ up: 32, left: 64 })
  expect(travelFrom(home, home)).toStrictEqual({ up: 0, left: 0 })
  expect(Object.is(travelFrom(home, { ...home, x: 1360.2, y: 820.3 }).up, 0)).toBe(true)
  expect(intersects(home, { x: 1380, y: 840, width: 100, height: 40 })).toBe(true)
  expect(intersects(home, { x: 0, y: 0, width: 100, height: 40 })).toBe(false)
})

test('S5: a move that eases over 150 ms is judged where it ends, not mid-way', async ({ page }) => {
  // The launcher's own easing (AssistantRoot.tsx: motion-safe:transition-[right,bottom…], 0.15 s).
  await page.setContent(`
    <button id="l" style="position:fixed;right:24px;bottom:24px;width:48px;height:48px;transition:right .15s,bottom .15s">L</button>
    <script>
      const l = document.getElementById('l')
      l.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp') l.style.bottom = (parseFloat(l.style.bottom) + 16) + 'px'
        if (e.key === 'Home') { l.style.right = '24px'; l.style.bottom = '24px' }
      })
    </script>`)
  const launcher = page.locator('#l')
  const home = await boxOf(launcher)
  await launcher.focus()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  // What the 3.00.00 spec did: one read straight away, still (nearly) at home.
  expect(travelFrom(home, await boxOf(launcher)).up).toBeLessThan(32)
  await expectTravel(launcher, home, { up: 32, left: 0 }, 'eased into place')
  await page.keyboard.press('Home')
  await expectTravel(launcher, home, { up: 0, left: 0 }, 'back home')
})

test('F5-b: the launcher is judged once it has settled, not mid-ease', async ({ page }) => {
  await page.setContent(`
    <button id="l" style="position:fixed;right:24px;bottom:24px;width:48px;height:48px;transition:bottom .15s">L</button>
    <script>
      const l = document.getElementById('l')
      l.addEventListener('click', () => { l.style.bottom = '124px' })
    </script>`)
  const launcher = page.locator('#l')
  const home = await boxOf(launcher)
  await launcher.click()
  const settled = await settledBoxOf(launcher)
  expect(travelFrom(home, settled)).toStrictEqual({ up: 100, left: 0 })
})

// ----------------------------------- every created id reaches the ledger ----

/** Every spec file (not the login-only setup). */
function specFiles(): string[] {
  return fs.readdirSync(path.join(E2E_ROOT, 'tests')).filter((file) => file.endsWith('.spec.ts'))
}
const specSource = (file: string): string => fs.readFileSync(path.join(E2E_ROOT, 'tests', file), 'utf8')

test('every spec uses the suite test (its contexts record conversations and browser creates)', () => {
  const specs = specFiles()
  expect(specs.length).toBeGreaterThan(20)
  expect(specs.filter((file) => !/import \{[^}]*\btest\b[^}]*\} from '\.\.\/lib\/test'/.test(specSource(file)))).toStrictEqual([])
  expect(specs.filter((file) => /import \{[^}]*\btest\b[^}]*\} from '@playwright\/test'/.test(specSource(file)))).toStrictEqual([])
})

/** `browser.newContext(` calls not passed straight to `prepareContext(` (a context the ledger would not see). */
function unpreparedContexts(source: string): string[] {
  return source.split('\n').flatMap((line, i) => {
    const code = line.replace(/\/\/.*$/, '')
    return /\bbrowser\.newContext\(/.test(code) && !/prepareContext\(\s*await\s+browser\.newContext\(/.test(code) ? [`${i + 1}: ${line.trim()}`] : []
  })
}

test('the context guard flags a raw browser.newContext and allows a prepared one', () => {
  expect(unpreparedContexts('const c = await browser.newContext({ storageState })')).toHaveLength(1)
  expect(unpreparedContexts('const c = prepareContext(await browser.newContext({ storageState }), role)')).toStrictEqual([])
  expect(unpreparedContexts('// The admin project\'s `use.storageState` also applies to browser.newContext(): start')).toStrictEqual([])
})

test('every context a spec opens itself is prepared, so an assistant or UI create there reaches the ledger', () => {
  const offenders = specFiles().flatMap((file) => unpreparedContexts(specSource(file)).map((hit) => `${file}:${hit}`))
  expect(offenders).toStrictEqual([])
})

/** Does this source start an autonomous-agent run (the UI's Run now, or the run route as the admin)? */
const startsAgentRun = (source: string): boolean =>
  /name: 'Run now'[^)]*\}\)\.click\(/.test(source) || /apiCall\('admin', 'POST', `\/agents\/[^`]*\/run`/.test(source)

test('a spec that starts an agent run checks the target first and records what the run created', () => {
  expect(startsAgentRun("await page.getByRole('button', { name: 'Run now' }).click()")).toBe(true)
  expect(startsAgentRun("await apiCall('admin', 'POST', `/agents/${id}/run`, {})")).toBe(true)
  // A refused probe as the user starts nothing.
  expect(startsAgentRun("['POST', `/agents/${aid}/run`, {}]")).toBe(false)
  const runners = specFiles().filter((file) => startsAgentRun(specSource(file)))
  expect(runners).toContain('s2-agents.spec.ts')
  for (const file of runners) {
    const source = specSource(file)
    expect(source, `${file}: imports the run-target check and the journal recorder`).toMatch(/import \{[^}]*\brecordRunProjects\b[^}]*\brunTargetProblems\b[^}]*\} from '\.\.\/lib\/agentRuns'/)
    expect(source, `${file}: deletes the projects its runs created`).toMatch(/deleteProjects\(/)
  }
})

test('no spec picks its conversations for cleanup by label (S3): by kind and run only', () => {
  const byLabel = /kind === 'conversation'[^\n]*\.name\b/
  expect(byLabel.test("readLedger().filter((e) => e.kind === 'conversation' && e.name.startsWith(PROJECT))")).toBe(true)
  expect(specFiles().filter((file) => byLabel.test(specSource(file)))).toStrictEqual([])
})

/**
 * The specs keep their 3.00.00 verify fixes (each pin fails if its spec goes back to
 * the code the verify run caught). The helpers they use are checked above.
 */
test('the 3.00.00 spec fixes stay in their specs (S1, S2, S4, S5, S6)', () => {
  const s2 = specSource('s2-agents.spec.ts')
  // S1: the custom step's field by its label, never "the first textarea of the panel".
  expect(s2).not.toMatch(/panel\.locator\('textarea'\)\.first\(\)/)
  expect(s2).toMatch(/panel\.getByLabel\('Instructions \(required\)', \{ exact: true \}\)/)
  // S1: every Run now checks the target first.
  expect(s2).toMatch(/async function runNowViaUi\([^\n]*\{\n\s*await expectSafeRunTarget\(/)

  const s3 = specSource('s3-personas-documents.spec.ts')
  // S2: after Restore, wait for the new newest version (re-expanding a remounted list).
  expect(s3).toMatch(/POST …\/versions[\s\S]{0,300}await expectNewestVersion\(page, newest \+ 1\)/)
  // S4: the content-addressed key layout, through lib/avatars.ts, never a hand-built flat key.
  expect(s3).toMatch(/existingAvatarKeys\(/)
  expect(s3).not.toMatch(/`avatars\/\$\{id\}\.\$\{ext\}`/)

  // S5: launcher moves are judged where they end.
  const bubble = specSource('assistant-bubble.spec.ts')
  expect(bubble).toMatch(/expectTravel\(launcher\(page\), home, \{ up: 2 \* KEY_STEP, left: KEY_STEP_LARGE \}/)
  expect(bubble).not.toMatch(/const moved = await boxOf\(launcher\(page\)\)\n\s*expect\(home\.y - moved\.y\)/)
  // F5-a/b judge the launcher's settled box, never one fixed-sleep read.
  expect(bubble).toMatch(/const bubble = await settledBoxOf\(launcher\(page\)\)/)
  expect(bubble).toMatch(/intersects\(await settledBoxOf\(launcher\(page\)\), await boxOf\(save\)\)/)
  expect(bubble).not.toMatch(/waitForTimeout/)

  // S6: the agent is reached in-app (so Back is a router POP), and a reload has its own native-prompt test.
  const guardSpec = specSource('unsaved-guard.spec.ts')
  const opener = /async function openAgentWithEdit[\s\S]*?\n {2}\}/.exec(guardSpec)?.[0] ?? ''
  expect(opener).toMatch(/getByRole\('link', \{ name: 'Autonomous agents'/)
  expect(opener).not.toMatch(/page\.goto\(site\(`\/agents\//)
  expect(guardSpec).toMatch(/F6-a6[\s\S]*window\.location\.reload\(\)[\s\S]*toEqual\(\['beforeunload'\]\)/)
})
