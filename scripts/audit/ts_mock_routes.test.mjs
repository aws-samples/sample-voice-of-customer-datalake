import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeMockRoutes } from './ts_mock_routes.mjs'
import { kinds, tempTree } from './ts_audit_fixture.mjs'

const SERVER = `
import { handleThings, sharedHelper } from './mock-things.js'
const handlers = {
  'GET /users': () => [],
  'POST /legacy': () => ({}),
}
export function serve(req, url) {
  const key = \`\${req.method} \${url.pathname}\`
  if (key === 'POST /chat/stream') return stream()
  if (url.pathname === '/health') return ok()
  const m = url.pathname.match(/^\\/feedback\\/([^/]+)\\/similar$/)
  if (req.method === 'GET' && m) return similar(m[1])
  if (url.pathname.match(/^\\/mock-upload\\/(.+)$/)) return upload()
  return handleThings(req, url) || sharedHelper(handlers[key])
}
`
const THINGS = `
const ROUTES = [
  { method: 'POST', pattern: /^\\/pins\\/([^/]+)\\/resolve$/, run: resolve },
  { method: 'POST', pattern: /^\\/pins\\/addressed$/, run: batch },
]
const TABLE = [
  ['GET', /^\\/logs\\/summary$/, 'none', summary],
  ['DELETE', /^\\/logs\\/summary$/, 'none', clear],
]
export function handleThings(req, url) { return ROUTES.length + TABLE.length }
export const sharedHelper = (x) => x
export function onlyHere() { return 1 }
export const neverUsed = 2
const call = () => onlyHere()
`
const PROBES = [
  { method: 'GET', path: '/users' },
  { method: 'POST', path: '/chat/stream' },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/feedback/f_1/similar' },
  // Relative to the module's mount (`/projects/{id}`): any /-suffix may match.
  { method: 'POST', path: '/projects/p_1/pins/pin_1/resolve' },
  { method: 'GET', path: '/logs/summary' },
]

test('reports routes no probe reaches (method-aware, mount-relative) and exports nothing imports', () => {
  const dir = tempTree({ 'mock-server.js': SERVER, 'mock-things.js': THINGS })
  try {
    const mocks = ['mock-server.js', 'mock-things.js'].map((rel) => ({ rel, file: join(dir, rel) }))
    const { findings, routes } = analyzeMockRoutes({ mocks, probes: PROBES, importers: mocks.map((m) => m.file) })
    assert.deepEqual(kinds(findings), {
      'mock-server.js::POST /legacy': 'mock-only',
      'mock-things.js::POST /^\\/pins\\/addressed$/': 'mock-only',
      'mock-things.js::DELETE /^\\/logs\\/summary$/': 'mock-only', // GET reaches the path, not DELETE
      'mock-server.js::export serve': 'mock-export-unused',
      'mock-things.js::export onlyHere': 'mock-export-unused',
      'mock-things.js::export neverUsed': 'mock-export-unused',
    })
    assert.match(findings.find((f) => f.key.endsWith('onlyHere')).detail, /drop the export/)
    assert.match(findings.find((f) => f.key.endsWith('neverUsed')).detail, /nothing uses it/)
    // /mock-upload is a presigned-upload fake: never judged, not even counted.
    assert.equal(routes, 9)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
