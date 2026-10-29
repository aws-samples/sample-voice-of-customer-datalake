/**
 * The test traffic tag (lib/trafficTag.ts): one `voc-e2e/<run tag>` per run, on every
 * browser context and every Node-side request.
 */
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { devices, expect, test } from '@playwright/test'
import {
  RUN_TAG_PATTERN, browserUserAgent, e2eFetch, nodeUserAgent, pinRunTag, runTagFrom, trafficToken,
} from '../lib/trafficTag'

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the run tag: E2E_TAG_RUN_ID, else the run id, else a timestamp', () => {
  expect(runTagFrom({ E2E_TAG_RUN_ID: 'e2e-20261010T080000Z', E2E_RUN_ID: '1717' })).toBe('e2e-20261010T080000Z')
  expect(runTagFrom({ E2E_TAG_RUN_ID: ' ', E2E_RUN_ID: 's1-1717' })).toBe('s1-1717')
  expect(runTagFrom({}, () => 42)).toBe('42')
  expect(() => runTagFrom({ E2E_TAG_RUN_ID: 'bad id' })).toThrow(/must match/)
  expect(() => runTagFrom({ E2E_TAG_RUN_ID: 'a'.repeat(65) })).toThrow(/must match/)
})

test('pinning writes the tag back once, so every later read (and every worker) gets the same one', () => {
  const env: Record<string, string | undefined> = {}
  const first = pinRunTag(env)
  expect(env['E2E_TAG_RUN_ID']).toBe(first)
  expect(trafficToken(env)).toBe(`voc-e2e/${first}`)
  // An unpinned env is pinned on first use, never re-stamped.
  const lazy: Record<string, string | undefined> = {}
  expect(trafficToken(lazy)).toBe(trafficToken(lazy))
})

test('the User-Agents: Desktop Chrome / node, then the token', () => {
  const env = { E2E_TAG_RUN_ID: 'run-1' }
  expect(browserUserAgent(env)).toBe(`${devices['Desktop Chrome'].userAgent} voc-e2e/run-1`)
  expect(nodeUserAgent(env)).toBe('node voc-e2e/run-1')
})

test('the Lambda side accepts the same run tags (shared/e2e_tag.py)', () => {
  const python = fs.readFileSync(path.resolve(E2E_ROOT, '..', '..', 'lambda', 'shared', 'e2e_tag.py'), 'utf8')
  expect(RUN_TAG_PATTERN.source).toBe('^[A-Za-z0-9._-]{1,64}$')
  expect(python).toContain('voc-e2e/([A-Za-z0-9._-]{1,64})')
})

test('a browser context of this runner sends the tag', async ({ page }) => {
  await page.setContent('<p>unit</p>')
  const agent = await page.evaluate(() => navigator.userAgent)
  expect(agent).toBe(browserUserAgent())
  expect(agent).toMatch(/ voc-e2e\/[A-Za-z0-9._-]{1,64}$/)
})

test('e2eFetch sends the tagged User-Agent and keeps the caller headers', async () => {
  const seen: http.IncomingHttpHeaders[] = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers)
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address: AddressInfo | string | null = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const response = await e2eFetch(`http://127.0.0.1:${String(address.port)}/x`, {
      headers: { Authorization: 'unit', 'User-Agent': 'overridden' },
    })
    expect(await response.text()).toBe('ok')
  } finally {
    server.close()
  }
  expect(seen[0]?.['user-agent']).toBe(nodeUserAgent())
  expect(seen[0]?.['authorization']).toBe('unit')
})

/** `.ts` files under `dir`, recursively. */
function sourcesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

/** Lines calling the global `fetch(` (not `route.fetch(`, `api.fetch(`, `e2eFetch(`). */
function bareFetches(source: string): string[] {
  return source.split('\n').flatMap((line, i) => {
    const code = line.replace(/\/\/.*$/, '')
    return /(?:^|[^.\w])fetch\(/.test(code) ? [`${String(i + 1)}: ${line.trim()}`] : []
  })
}

test('the bare-fetch guard flags the global fetch only', () => {
  expect(bareFetches('const r = await fetch(url)')).toHaveLength(1)
  expect(bareFetches('const r = await e2eFetch(url)\nawait route.fetch()\nawait api.fetch(u)')).toStrictEqual([])
})

test('every Node-side request in lib/ and tests/ goes through e2eFetch', () => {
  const tagModule = path.join(E2E_ROOT, 'lib', 'trafficTag.ts')
  const offenders = ['lib', 'tests'].flatMap((dir) => sourcesUnder(path.join(E2E_ROOT, dir)))
    .filter((file) => file !== tagModule)
    .flatMap((file) => bareFetches(fs.readFileSync(file, 'utf8')).map((hit) => `${path.relative(E2E_ROOT, file)}:${hit}`))
  expect(offenders).toStrictEqual([])
})

test('every runner config tags its browser contexts', () => {
  const configs = fs.readdirSync(E2E_ROOT).filter((file) => /^playwright.*\.config\.ts$/.test(file))
  expect(configs.length).toBeGreaterThanOrEqual(5)
  const untagged = configs.filter((file) => !/\bsharedConfig\(|\bbrowserUserAgent\(/.test(fs.readFileSync(path.join(E2E_ROOT, file), 'utf8')))
  expect(untagged).toStrictEqual([])
})
