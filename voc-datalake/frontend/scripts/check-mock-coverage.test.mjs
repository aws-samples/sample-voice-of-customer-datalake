#!/usr/bin/env node

/**
 * Tests for the mock-coverage gate (check-mock-coverage.mjs): call-site
 * extraction, the manifest diff, and how a probe answer is judged.
 *
 * Run: node --test scripts/check-mock-coverage.test.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { collectCallSites, manifestProblems, probeFailure, siteKey } from './check-mock-coverage.mjs'

/** A throwaway `src/` with the given files, removed after the suite. */
function fakeSrc(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mock-coverage-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

describe('collectCallSites', () => {
  const dir = fakeSrc({
    'api/things.ts': [
      "export const list = () => fetchApi('/things')",
      "export const make = (b: unknown) => fetchApi('/things', { method: 'POST', body: JSON.stringify(b) })",
      'export const change = (id: string) => fetchApi(`/things/${id}`, put({ a: 1 }))',
      'export const odd = (o: RequestInit) => fetchApi(`/things/odd`, o)',
    ].join('\n'),
    'api/things.test.ts': "fetchApi('/only-in-a-spec')",
    'pages/x-fixtures.tsx': "fetchApi('/only-in-a-fixture')",
  })
  after(() => rmSync(dir, { recursive: true, force: true }))
  const sites = [...collectCallSites(dir).values()]

  it('reads the method from a literal, a helper, or defaults to GET', () => {
    const byCall = Object.fromEntries(sites.map((s) => [s.call, s.method]))
    // Two sites share the call text '/things'; the method keeps them apart.
    assert.deepEqual(
      sites.filter((s) => s.call === "'/things'").map((s) => s.method).sort((a, b) => a.localeCompare(b)),
      ['GET', 'POST'],
    )
    assert.equal(byCall['`/things/${id}`'], 'PUT')
  })

  it('marks an options argument it cannot read as UNKNOWN so the gate fails loudly', () => {
    assert.match(sites.find((s) => s.call === '`/things/odd`')?.method ?? '', /^UNKNOWN/)
  })

  it('skips specs and fixtures and keys files relative to src/', () => {
    assert.deepEqual([...new Set(sites.map((s) => s.file))], ['api/things.ts'])
  })
})

describe('manifestProblems', () => {
  const site = { file: 'api/a.ts', method: 'GET', call: "'/a'" }
  const sites = new Map([[siteKey(site), site]])

  it('reports nothing when every site has an entry with probes', () => {
    assert.deepEqual(manifestProblems(sites, new Map([[siteKey(site), { ...site, probes: [{ path: '/a' }] }]])), [])
  })

  it('reports a call site that has no entry', () => {
    const [problem] = manifestProblems(sites, new Map())
    assert.match(problem, /not in mock-coverage\.json/)
  })

  it('reports a stale entry and an entry without probes', () => {
    const stale = { file: 'api/gone.ts', method: 'GET', call: "'/gone'", probes: [] }
    const problems = manifestProblems(sites, new Map([[siteKey(site), { ...site, probes: [{ path: '/a' }] }], [siteKey(stale), stale]]))
    assert.equal(problems.length, 2)
    assert.match(problems.join('\n'), /stale .*api\/gone\.ts/)
    assert.match(problems.join('\n'), /entry without probes/)
  })
})

describe('probeFailure', () => {
  const ANSWERS = {
    '/ok': [200, '{"ok":true}'],
    '/validation': [400, '{"success":false,"error":"name is required"}'],
    '/specific-404': [404, '{"success":false,"error":"Project not found"}'],
    '/generic-404': [404, '{"error":"Not found"}'],
    '/method': [405, '{"success":false,"error":"Method not allowed"}'],
    '/boom': [500, '{"error":"boom"}'],
  }
  let server
  let base
  before(async () => {
    server = createServer((req, res) => {
      const [status, body] = ANSWERS[req.url] ?? [404, '{"error":"Not found"}']
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body)
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(() => new Promise((done) => server.close(done)))

  it('passes a 200 and a route-specific 4xx (the route exists)', async () => {
    for (const path of ['/ok', '/validation', '/specific-404']) {
      assert.equal(await probeFailure(base, 'GET', { path }), null, path)
    }
  })

  it("fails the mock's generic fallback 404, a 405 and a 5xx", async () => {
    assert.match(await probeFailure(base, 'GET', { path: '/generic-404' }), /no mock route/)
    assert.match(await probeFailure(base, 'GET', { path: '/method' }), /405/)
    assert.match(await probeFailure(base, 'POST', { path: '/boom', body: { a: 1 } }), /mock error 500/)
  })

  it('fails when nothing is listening', async () => {
    assert.match(await probeFailure('http://127.0.0.1:1', 'GET', { path: '/x' }), /request failed/)
  })
})
