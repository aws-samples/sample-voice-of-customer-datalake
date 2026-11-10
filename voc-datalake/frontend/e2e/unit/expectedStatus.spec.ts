/**
 * Expected refusals (lib/trafficTag.ts `expectedStatusToken`, lib/expectedRefusal.ts): a request the suite MEANS to
 * be refused carries `voc-e2e-expect/<status>` in its User-Agent, so the log sweep can tell that 4xx from a real one.
 */
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { expectRefusal, refusalMatches } from '../lib/expectedRefusal'
import { browserUserAgent, e2eFetch, expectedStatusToken, nodeUserAgent, nodeUserAgentExpecting } from '../lib/trafficTag'

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A local server that records each request's method, path and User-Agent. */
async function recordingServer(): Promise<{ origin: string; seen: Array<{ method: string; url: string; agent: string }>; close: () => void }> {
  const seen: Array<{ method: string; url: string; agent: string }> = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', agent: req.headers['user-agent'] ?? '' })
    res.setHeader('Content-Type', 'text/html')
    res.end('<p>ok</p>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address: AddressInfo | string | null = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { origin: `http://127.0.0.1:${String(address.port)}`, seen, close: () => server.close() }
}

test('the expect token: 4xx only, sorted and de-duplicated', () => {
  expect(expectedStatusToken([404, 403, 403])).toBe('voc-e2e-expect/403,404')
  expect(expectedStatusToken([])).toBeNull()
  expect(expectedStatusToken()).toBeNull()
  for (const bad of [200, 302, 500, 404.5]) expect(() => expectedStatusToken([bad]), String(bad)).toThrow(/must be a 4xx/)
  expect(() => expectedStatusToken([403, 500])).toThrow(/must be a 4xx/)
  const env = { E2E_TAG_RUN_ID: 'run-1' }
  expect(nodeUserAgentExpecting([409], env)).toBe('node voc-e2e/run-1 voc-e2e-expect/409')
  expect(nodeUserAgentExpecting([], env)).toBe('node voc-e2e/run-1')
})

test('e2eFetch with `expect` adds the token; without it the User-Agent is unchanged', async () => {
  const server = await recordingServer()
  try {
    await (await e2eFetch(`${server.origin}/refused`, { headers: { 'User-Agent': 'overridden' } }, { expect: [403] })).text()
    await (await e2eFetch(`${server.origin}/plain`)).text()
    await (await e2eFetch(`${server.origin}/empty`, {}, { expect: [] })).text()
  } finally {
    server.close()
  }
  expect(server.seen.map((s) => s.agent)).toStrictEqual([`${nodeUserAgent()} voc-e2e-expect/403`, nodeUserAgent(), nodeUserAgent()])
  expect(server.seen[0]?.agent).toMatch(/^node voc-e2e\/[A-Za-z0-9._-]{1,64} voc-e2e-expect\/403$/)
})

test('refusalMatches: the API origin, the method (or any) and the path pattern', () => {
  const origin = 'https://api.unit.example'
  const put = { method: 'PUT', path: /\/workflows\/[^/]+$/, origin }
  expect(refusalMatches(put, 'PUT', `${origin}/v1/workflows/wf_1`)).toBe(true)
  expect(refusalMatches(put, 'put', `${origin}/v1/workflows/wf_1`)).toBe(true)
  expect(refusalMatches(put, 'GET', `${origin}/v1/workflows/wf_1`)).toBe(false)
  expect(refusalMatches(put, 'PUT', `${origin}/v1/workflows/wf_1/export`)).toBe(false)
  expect(refusalMatches(put, 'PUT', `https://site.unit.example/v1/workflows/wf_1`)).toBe(false)
  expect(refusalMatches({ path: /^\/v1\/projects\/p1(\/|$)/, origin }, 'DELETE', `${origin}/v1/projects/p1/jobs`)).toBe(true)
  // Without an origin it is the configured API's (playwright.unit.config.ts: https://api.unit.example/v1).
  expect(refusalMatches({ path: /\/x$/ }, 'GET', 'https://api.unit.example/v1/x')).toBe(true)
})

test('expectRefusal tags only the matching browser requests, and only while its action runs', async ({ page }) => {
  const server = await recordingServer()
  try {
    await page.goto(`${server.origin}/page`)
    const call = (method: string, p: string) => page.evaluate(async ([m, u]) => { await (await fetch(u ?? '', { method: m })).text() }, [method, p])
    await expectRefusal(page, { method: 'PUT', path: /\/stale$/, origin: server.origin }, [409], async () => {
      await call('PUT', '/stale')
      await call('GET', '/stale')
      await call('PUT', '/other')
    })
    await call('PUT', '/stale')
    await expect(expectRefusal(page, { path: /x/ }, [500], async () => undefined)).rejects.toThrow(/must be a 4xx/)
  } finally {
    server.close()
  }
  const browser = browserUserAgent()
  expect(server.seen.filter((s) => s.url !== '/page' && s.url !== '/favicon.ico').map((s) => `${s.method} ${s.url} ${s.agent}`)).toStrictEqual([
    `PUT /stale ${browser} voc-e2e-expect/409`,
    `GET /stale ${browser}`,
    `PUT /other ${browser}`,
    `PUT /stale ${browser}`,
  ])
})

// ── the source scan ─────────────────────────────────────────────────────────

/** The request helpers whose call must carry the declaration when its status is asserted to be a 4xx. */
const REQUEST_CALLS = ['apiCall', 'e2eFetch', 'probe', 'readProject', 'listStatus', 'personStatus', 'requestStatus', 'mcpToolsList', 'post']
const CALL_NAMES = REQUEST_CALLS.join('|')
const CALL = new RegExp(`(?:^|[^.\\w])(?<name>${CALL_NAMES})\\(`)
/** An assertion that a status is one 4xx (`expect(res.status).toBe(404)`, `expect(await listStatus(id)).toBe(404)`). */
const ASSERTS_4XX = /expect(?:\.soft)?\((.*)\)\.toBe\(4\d\d\)/
/** What declares the refusal in a call's arguments. */
const DECLARES = /\bexpect:|\bGONE\b/
/** How far back an asserted result may have been fetched. */
const WINDOW_LINES = 8

/**
 * `file:line` sites the scan cannot match, each with its reason. Empty: an assertion whose request the scan cannot
 * find (the `getStatus` of lib/runCleanup.ts proofs, whose GET declares 404 itself) is skipped, not flagged.
 */
const ALLOWLIST: ReadonlySet<string> = new Set<string>()

/** The text of the call starting at `start` (the helper name), up to its balanced closing paren. */
function callText(source: string, start: number): string {
  const open = source.indexOf('(', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return source.slice(start)
}

/** The source offset where each line starts. */
function lineOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = []
  let at = 0
  for (const line of lines) {
    offsets.push(at)
    at += line.length + 1
  }
  return offsets
}

/** Whether the call `match` found at `offset` in `source` passes a declaration. */
function declared(source: string, offset: number, match: RegExpExecArray): boolean {
  const name = match.groups?.['name'] ?? ''
  return DECLARES.test(callText(source, offset + match.index + match[0].lastIndexOf(`${name}(`)))
}

/**
 * Every 4xx status assertion whose request call (inline in the assertion, or `const <x> = await <call>(` within
 * WINDOW_LINES before it) passes no declaration. Returns `file:line` entries.
 */
function undeclaredRefusals(file: string, source: string): string[] {
  const lines = source.split('\n')
  const offsets = lineOffsets(lines)
  const offenders: string[] = []
  lines.forEach((line, i) => {
    const asserted = ASSERTS_4XX.exec(line.replace(/\/\/.*$/, ''))
    if (asserted === null) return
    const site = `${file}:${String(i + 1)}`
    const expr = asserted[1] ?? ''
    const inline = CALL.exec(expr)
    if (inline !== null) {
      if (!declared(source, (offsets[i] ?? 0) + line.indexOf(expr), inline)) offenders.push(site)
      return
    }
    const variable = /^\(?(?:await\s+)?([A-Za-z_$][\w$]*)/.exec(expr)?.[1]
    if (variable === undefined) return
    for (let j = i; j >= Math.max(0, i - WINDOW_LINES); j -= 1) {
      const assign = new RegExp(`const ${variable}(?::[^=]+)? = await (?<name>${CALL_NAMES})\\(`).exec(lines[j] ?? '')
      if (assign === null) continue
      if (!declared(source, offsets[j] ?? 0, assign)) offenders.push(site)
      return
    }
  })
  return offenders
}

function sourcesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

test('the scan flags an undeclared refusal and passes a declared one', () => {
  const undeclared = "const res = await apiCall('user', 'PUT', '/x', {})\nexpect(res.status).toBe(403)"
  expect(undeclaredRefusals('a.ts', undeclared)).toStrictEqual(['a.ts:2'])
  expect(undeclaredRefusals('a.ts', "const res = await apiCall('user', 'PUT', '/x', {}, { expect: [403] })\nexpect(res.status).toBe(403)")).toStrictEqual([])
  expect(undeclaredRefusals('a.ts', "expect((await apiCall('user', 'GET', `/p/${encodeURIComponent(id)}`)).status, 'gate').toBe(403)")).toStrictEqual(['a.ts:1'])
  expect(undeclaredRefusals('a.ts', "expect((await apiCall('user', 'GET', `/p/${encodeURIComponent(id)}`, undefined, { expect: [403] })).status).toBe(403)")).toStrictEqual([])
  expect(undeclaredRefusals('a.ts', 'expect(await listStatus(id), "gone").toBe(404)')).toStrictEqual(['a.ts:1'])
  expect(undeclaredRefusals('a.ts', 'expect(await listStatus(id, GONE), "gone").toBe(404)')).toStrictEqual([])
  // A multi-line call is read to its closing paren.
  expect(undeclaredRefusals('a.ts', "const r = await e2eFetch(url, {\n  method: 'POST',\n}, { expect: [404] })\nexpect(r.status).toBe(404)")).toStrictEqual([])
  // A success assertion is not judged.
  expect(undeclaredRefusals('a.ts', "const r = await apiCall('admin', 'GET', '/x')\nexpect(r.status).toBe(200)")).toStrictEqual([])
})

test('every asserted 4xx in lib/ and tests/ declares it', () => {
  const offenders = ['lib', 'tests'].flatMap((dir) => sourcesUnder(path.join(E2E_ROOT, dir)))
    .flatMap((file) => undeclaredRefusals(path.relative(E2E_ROOT, file), fs.readFileSync(file, 'utf8')))
    .filter((site) => !ALLOWLIST.has(site))
  expect(offenders).toStrictEqual([])
})
