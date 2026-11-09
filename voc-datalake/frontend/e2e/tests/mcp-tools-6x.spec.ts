/**
 * Global MCP tools of 6.04.00 (CHANGELOG "Global MCP tools", docs/mcp.md → Tools), both roles,
 * each with its own READ token minted through `POST /connect/tokens` (1 day, the shortest).
 *
 * 1. `tools/list` offers exactly the handler's read tools (the `GlobalTool(...)` tables in
 *    lambda/shared/mcp_global_tools*.py, parsed here, not guessed): every one `readOnlyHint: true`,
 *    no write tool (`write=True`, which needs a read-write token) listed.
 * 2. `get_feedback_catalogue` = `GET /feedback/catalogue`; with `sources: true` = `GET /sources/status`.
 * 3. `read_radar` / `get_prioritization`: a JSON-RPC result shaped like `GET /radar` (no `settings`)
 *    and `GET /projects/prioritization`.
 * 4. `get_job` with an unknown job id: a tool error naming the route's 404, never a JSON-RPC error.
 * 5. `generate` / `edit_feedback` / `score_prioritization` with the read token: the handler's scope
 *    refusal (`<tool> needs a read-write token; this token is read-only`). The scope check runs
 *    before the route request is even built (mcp_global_handler.py `_check_allowed`), and each body
 *    is one the tool itself rejects anyway (unknown step, no change, no scores), so nothing can write.
 * 6. `GET /connect/tokens/{id}` lists those calls (tool, outcome, project_id, at) and never an argument.
 *
 * Production-safe: the only writes are the two e2e-named tokens, ledger-recorded the moment their
 * id is known and revoked in afterAll (the ledger cleanup covers a crash). The secret is held in
 * memory only, never logged or written.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, stringField } from '../lib/api'
import { apiUrl, RUN_PREFIX, type Role } from '../lib/env'
import { roleOf } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { recordCreated } from '../lib/ledger'
import { e2eFetch } from '../lib/trafficTag'

const SHARED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../lambda/shared')
const TOOL_SOURCES = ['mcp_global_tools.py', 'mcp_global_tools_steps.py', 'mcp_global_tools_work.py']
/** The read tools 6.04.00 added (CHANGELOG); each must be in the handler's table AND listed. */
const NEW_READ_TOOLS = ['get_job', 'read_radar', 'get_feedback_catalogue', 'get_prioritization']
/** The write tools 6.04.00 added; never listed to, and refused for, a read token. */
const NEW_WRITE_TOOLS = ['generate', 'edit_feedback', 'score_prioritization', 'write_feature_request']
/** `mcp_global_tokens.audit_view`: exactly the four recorded facts. */
const AUDIT_KEYS = ['at', 'outcome', 'project_id', 'tool']
/** The audit row is written after the answer (best effort) and read eventually consistent. */
const AUDIT_WAIT_MS = 15_000

interface HandlerTool { name: string, write: boolean, adminOnly: boolean }

/** Every `GlobalTool('<name>', ...)` of the handler's tables with its `write=` / `admin_only=` flags. */
function handlerTools(): HandlerTool[] {
  const tools: HandlerTool[] = []
  for (const file of TOOL_SOURCES) {
    const source = fs.readFileSync(path.join(SHARED_DIR, file), 'utf8')
    const blocks = source.split(/\bGlobalTool\(/).slice(1)
    for (const block of blocks) {
      const name = /^\s*'([a-z_]+)'/.exec(block)?.[1]
      if (name === undefined) continue
      // A block runs to the next `GlobalTool(`; the last one to the tuple's end.
      const body = block.split(/\n\)\n/)[0] ?? block
      tools.push({ name, write: /\bwrite=True\b/.test(body), adminOnly: /\badmin_only=True\b/.test(body) })
    }
  }
  return tools
}

interface ToolAnswer {
  status: number
  /** JSON-RPC `error` (a protocol fault), undefined for a tool result. */
  rpcError: Record<string, unknown> | undefined
  isError: boolean | undefined
  text: string
  /** `structuredContent`, else the text parsed as JSON (null when it is not JSON). */
  data: unknown
  result: Record<string, unknown> | undefined
}

let rpcId = 0

/** One JSON-RPC call to `POST /mcp/global` with `token` (never logged). */
async function mcp(token: string, method: string, params?: Record<string, unknown>): Promise<ToolAnswer> {
  rpcId += 1
  const response = await e2eFetch(`${apiUrl()}/mcp/global`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, ...(params ? { params } : {}) }),
  })
  const raw = await response.text()
  const body: unknown = (() => { try { return JSON.parse(raw) } catch { return null } })()
  const result = isRecord(body) && isRecord(body['result']) ? body['result'] : undefined
  const content = result?.['content']
  const first = Array.isArray(content) ? content[0] : undefined
  const text = isRecord(first) && typeof first['text'] === 'string' ? first['text'] : ''
  const structured = result?.['structuredContent']
  const data: unknown = structured !== undefined ? structured : (() => { try { return JSON.parse(text) } catch { return null } })()
  return {
    status: response.status,
    rpcError: isRecord(body) && isRecord(body['error']) ? body['error'] : undefined,
    isError: typeof result?.['isError'] === 'boolean' ? result['isError'] : undefined,
    text,
    data,
    result,
  }
}

const callTool = (token: string, name: string, args: Record<string, unknown>): Promise<ToolAnswer> =>
  mcp(token, 'tools/call', { name, arguments: args })

/** A successful tool call: HTTP 200, no JSON-RPC error, `isError: false`, a JSON object. */
function expectOk(answer: ToolAnswer, tool: string): Record<string, unknown> {
  expect(answer.status, `${tool}: HTTP status`).toBe(200)
  expect(answer.rpcError, `${tool}: JSON-RPC error`).toBeUndefined()
  expect(answer.isError, `${tool}: isError (${answer.text.slice(0, 200)})`).toBe(false)
  expect(isRecord(answer.data), `${tool}: a JSON object result`).toBe(true)
  return isRecord(answer.data) ? answer.data : {}
}

/** Keys MCP's `stripped` keeps (mcp_global_kit `_HIDDEN_KEYS`, no `*url*` key). */
const HIDDEN = new Set(['pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'secret_hash',
  'kiro_default_export_prompt', 'kiro_export_prompt'])
const publicKeys = (row: Record<string, unknown>, drop: string[] = []): string[] =>
  Object.keys(row).filter((k) => !HIDDEN.has(k) && !k.toLowerCase().includes('url') && !drop.includes(k)).sort()

async function restBody(role: Role, route: string): Promise<Record<string, unknown>> {
  const answer = await apiCall(role, 'GET', route)
  expect(answer.status, `GET ${route}`).toBe(200)
  return isRecord(answer.body) ? answer.body : {}
}

interface Minted { id: string, secret: string }
let token: Minted | undefined
let role: Role = 'user'
/** The tool calls this spec made with the token, and the audit outcome each must leave. */
const expectedAudit: Array<{ tool: string, outcome: string, projectId: string | null }> = []
const safeId = (suffix: string): string => `${RUN_PREFIX}${suffix}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128)
/** Argument values the audit log must never show (test 6). */
const ARGUMENT_MARKER = safeId('argument-marker')
const UNKNOWN_JOB = safeId('no-job')
const UNKNOWN_PROJECT = safeId('no-project')
const UNKNOWN_STEP = 'not-a-step'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({}, testInfo) => {
  role = roleOf(testInfo)
  const name = `${RUN_PREFIX}mcp6-read-${role}`
  const minted = await apiCall(role, 'POST', '/connect/tokens', { name, scope: 'read', expires_in_days: 1 })
  const body = isRecord(minted.body) ? minted.body : {}
  const id = stringField(body, 'token_id')
  expect(minted.status, 'POST /connect/tokens').toBeLessThan(300)
  if (id === undefined) throw new Error('POST /connect/tokens answered no token_id')
  recordCreated('token', id, name, role)
  expect(stringField(body, 'scope')).toBe('read')
  token = { id, secret: stringField(body, 'token') ?? '' }
})

test.afterAll(async () => {
  if (token === undefined) return
  const revoked = await apiCall(role, 'DELETE', `/connect/tokens/${encodeURIComponent(token.id)}`)
  token = undefined
  expect(revoked.status, 'revoke the read token').toBe(200)
})

const secret = (): string => {
  if (token === undefined || token.secret === '') throw new Error('no read token was minted')
  return token.secret
}

test.describe('global MCP tools (6.04)', () => {
  test('tools/list with a read token offers exactly the handler\'s read tools', async () => {
    const table = handlerTools()
    const names = table.map((t) => t.name)
    for (const tool of [...NEW_READ_TOOLS, ...NEW_WRITE_TOOLS]) expect(names, `handler table has ${tool}`).toContain(tool)
    for (const tool of NEW_WRITE_TOOLS) expect(table.find((t) => t.name === tool)?.write, `${tool} is write`).toBe(true)
    for (const tool of NEW_READ_TOOLS) expect(table.find((t) => t.name === tool)?.write, `${tool} is read`).toBe(false)

    const listed = await mcp(secret(), 'tools/list')
    expect(listed.status).toBe(200)
    expect(listed.rpcError).toBeUndefined()
    const tools = Array.isArray(listed.result?.['tools']) ? listed.result['tools'].filter(isRecord) : []
    const listedNames = tools.map((t) => String(t['name'])).sort()
    const readNames = table.filter((t) => !t.write && !t.adminOnly).map((t) => t.name).sort()
    expect(listedNames, 'a read token sees every read tool and nothing else').toEqual(readNames)
    for (const tool of tools) {
      const annotations = isRecord(tool['annotations']) ? tool['annotations'] : {}
      expect(annotations['readOnlyHint'], `${String(tool['name'])} readOnlyHint`).toBe(true)
    }
    for (const write of table.filter((t) => t.write)) expect(listedNames).not.toContain(write.name)
  })

  test('get_feedback_catalogue answers the catalogue, and the source status with sources: true', async () => {
    const catalogue = expectOk(await callTool(secret(), 'get_feedback_catalogue', {}), 'get_feedback_catalogue')
    expectedAudit.push({ tool: 'get_feedback_catalogue', outcome: 'ok', projectId: null })
    const rest = await restBody(role, '/feedback/catalogue')
    expect(publicKeys(catalogue)).toEqual(publicKeys(rest))
    expect(catalogue['version']).toEqual(rest['version'])
    const fieldNames = (doc: Record<string, unknown>): string[] =>
      (Array.isArray(doc['fields']) ? doc['fields'].filter(isRecord) : []).map((f) => String(f['name']))
    expect(fieldNames(catalogue).length).toBeGreaterThan(0)
    expect(fieldNames(catalogue)).toEqual(fieldNames(rest))

    const sources = expectOk(await callTool(secret(), 'get_feedback_catalogue', { sources: true }), 'get_feedback_catalogue sources')
    expectedAudit.push({ tool: 'get_feedback_catalogue', outcome: 'ok', projectId: null })
    const restSources = await restBody(role, '/sources/status')
    expect(publicKeys(sources), 'the same sources as GET /sources/status').toEqual(publicKeys(restSources))
    expect(sources['fields'], 'not the catalogue').toBeUndefined()
  })

  test('read_radar and get_prioritization answer like their REST routes', async () => {
    const radar = expectOk(await callTool(secret(), 'read_radar', {}), 'read_radar')
    expectedAudit.push({ tool: 'read_radar', outcome: 'ok', projectId: null })
    expect(radar['settings'], 'the scan settings are left out').toBeUndefined()
    expect(publicKeys(radar)).toEqual(publicKeys(await restBody(role, '/radar'), ['settings']))

    const board = expectOk(await callTool(secret(), 'get_prioritization', {}), 'get_prioritization')
    expectedAudit.push({ tool: 'get_prioritization', outcome: 'ok', projectId: null })
    expect(publicKeys(board)).toEqual(publicKeys(await restBody(role, '/projects/prioritization')))
    expect(isRecord(board['rows']), 'rows is an object keyed by row id').toBe(true)
  })

  test('get_job with an unknown job id is a not-found tool error, not a server fault', async () => {
    const listed = await apiCall(role, 'GET', '/projects')
    const projects = isRecord(listed.body) && Array.isArray(listed.body['projects']) ? listed.body['projects'].filter(isRecord) : []
    // A project the caller can view, so the 404 is the job's; none = an unknown project (also a 404).
    const projectId = stringField(projects[0], 'project_id') ?? UNKNOWN_PROJECT
    const answer = await callTool(secret(), 'get_job', { project_id: projectId, job_id: UNKNOWN_JOB })
    expectedAudit.push({ tool: 'get_job', outcome: 'error', projectId })
    expect(answer.status).toBe(200)
    expect(answer.rpcError, 'not a JSON-RPC (server) error').toBeUndefined()
    expect(answer.isError).toBe(true)
    expect(answer.text).toMatch(/\(HTTP 404\)/)
  })

  test('generate, edit_feedback and score_prioritization are refused for a read token', async () => {
    const calls: Array<{ tool: string, args: Record<string, unknown>, projectId: string | null }> = [
      // Each body is one the tool rejects by itself too: an unknown step, no change, no scores.
      { tool: 'generate', args: { project_id: UNKNOWN_PROJECT, step: UNKNOWN_STEP, brief: ARGUMENT_MARKER }, projectId: UNKNOWN_PROJECT },
      { tool: 'edit_feedback', args: { feedback_id: ARGUMENT_MARKER }, projectId: null },
      { tool: 'score_prioritization', args: { row_id: ARGUMENT_MARKER, scores: {} }, projectId: null },
    ]
    for (const call of calls) {
      const answer = await callTool(secret(), call.tool, call.args)
      expectedAudit.push({ tool: call.tool, outcome: 'denied', projectId: call.projectId })
      expect(answer.status).toBe(200)
      expect(answer.rpcError, `${call.tool}: a tool result`).toBeUndefined()
      expect(answer.isError, `${call.tool}: isError`).toBe(true)
      expect(answer.text).toBe(`${call.tool} needs a read-write token; this token is read-only`)
    }
  })

  test('the token\'s audit log records each call (tool, outcome), never its arguments', async () => {
    test.skip(expectedAudit.length === 0, 'no tool call was made by the earlier tests')
    const id = token?.id ?? ''
    let events: Array<Record<string, unknown>> = []
    let raw = ''
    const deadline = Date.now() + AUDIT_WAIT_MS
    const countOf = (list: Array<Record<string, unknown>>, tool: string, outcome: string): number =>
      list.filter((e) => e['tool'] === tool && e['outcome'] === outcome).length
    const want = (tool: string, outcome: string): number =>
      expectedAudit.filter((e) => e.tool === tool && e.outcome === outcome).length
    const complete = (): boolean => expectedAudit.every((e) => countOf(events, e.tool, e.outcome) >= want(e.tool, e.outcome))
    do {
      const detail = await apiCall(role, 'GET', `/connect/tokens/${encodeURIComponent(id)}`)
      expect(detail.status).toBe(200)
      raw = JSON.stringify(detail.body)
      events = isRecord(detail.body) && Array.isArray(detail.body['events']) ? detail.body['events'].filter(isRecord) : []
      if (complete()) break
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    } while (Date.now() < deadline)

    for (const call of expectedAudit) {
      expect(countOf(events, call.tool, call.outcome), `audit has ${call.tool} → ${call.outcome}`)
        .toBeGreaterThanOrEqual(want(call.tool, call.outcome))
      if (call.projectId !== null) {
        expect(events.some((e) => e['tool'] === call.tool && e['project_id'] === call.projectId),
          `${call.tool} audit carries its project`).toBe(true)
      }
    }
    expect(events.filter((e) => e['tool'] === 'tools/list'), 'tools/list is not a tool call').toEqual([])
    for (const event of events) expect(Object.keys(event).sort()).toEqual(AUDIT_KEYS)
    expect(raw, 'no argument value reaches the audit log').not.toContain(ARGUMENT_MARKER)
    expect(raw).not.toContain(UNKNOWN_STEP)
    expect(raw).not.toContain(UNKNOWN_JOB)
  })
})
