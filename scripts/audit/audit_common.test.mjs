// audit_common.mjs: the shared CLI / report / allowlist contract of the Node detectors.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AuditError, EXIT, applyAllowlist, checkVacuity, detectorMain, globRegex, isTestPath, keyRegex, parseArgs, printReport, readAllowlist,
  splitAllowlisted,
} from './audit_common.mjs'
import { tempTree } from './ts_audit_fixture.mjs'

/** Run `fn` with console.log / stdout captured; returns `{value, out}`. */
function capture(fn) {
  const chunks = []
  const [log, write] = [console.log, process.stdout.write]
  console.log = (text) => chunks.push(`${text}\n`)
  process.stdout.write = (text) => chunks.push(String(text))
  try {
    return { value: fn(), out: chunks.join('') }
  } finally {
    console.log = log
    process.stdout.write = write
  }
}

test('--json alone means stdout, --json PATH / --json=PATH a file; positionals stay positional', () => {
  assert.equal(parseArgs(['--json']).json, true)
  assert.equal(parseArgs(['--json', 'out.json', 'src'], {}).json, 'out.json')
  assert.equal(parseArgs(['--json=out.json']).json, 'out.json')
  assert.deepEqual(parseArgs(['--json', '--x'], { x: 'boolean' }), { _: [], json: true, x: true })
  assert.equal(parseArgs(['-h']).help, true)
  assert.throws(() => parseArgs(['--nope']), AuditError)
  assert.throws(() => parseArgs(['--n'], { n: 'number' }), AuditError)
})

test('the text report starts with the one-line summary; --json alone prints JSON only; a path gets it too', () => {
  const findings = [{ kind: 'dead', key: 'a', detail: 'x' }]
  const text = capture(() => printReport('tool', findings, { summary: 'saw 3' }))
  assert.equal(text.value, EXIT.findings)
  assert.equal(text.out.split('\n')[0], 'tool: 1 finding(s); saw 3')
  const json = capture(() => printReport('tool', findings, { json: true }))
  assert.deepEqual(JSON.parse(json.out).findings, findings)
  const file = join(tempTree({}), 'r.json')
  const both = capture(() => printReport('tool', [], { json: file }))
  assert.equal(both.value, EXIT.clean)
  assert.match(both.out, /^tool: 0 finding\(s\)/)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).summary, 'tool: 0 finding(s)')
})

test('detectorMain: --help exits 0 and names --json; an AuditError is exit 2', async () => {
  const main = detectorMain('t', { usage: 'what it finds', spec: { root: 'string' } }, () => { throw new AuditError('vacuous') })
  const help = capture(() => main(['--help']))
  assert.equal(help.value, EXIT.clean)
  assert.match(help.out, /\[--root <string>\].*--json/)
  const error = console.error
  console.error = () => {}
  try {
    assert.equal(main([]), EXIT.error)
    assert.equal(await detectorMain('t', { usage: '' }, async () => { throw new AuditError('x') })([]), EXIT.error)
  } finally {
    console.error = error
  }
})

test('one allowlist loader for every shape: reason mandatory, shape keys required, stale entries returned', () => {
  const dir = tempTree({
    'ok.json': JSON.stringify({ entries: [{ files: ['src/**'], reason: 'kept' }, { files: ['gone/*'], reason: 'old' }] }),
    'no-reason.json': JSON.stringify({ entries: [{ files: ['x'] }] }),
    'no-shape.json': JSON.stringify({ entries: [{ reason: 'r' }] }),
  })
  const entries = readAllowlist(join(dir, 'ok.json'), ['files'])
  assert.throws(() => readAllowlist(join(dir, 'no-reason.json'), ['files']), /no reason/)
  assert.throws(() => readAllowlist(join(dir, 'no-shape.json'), ['files']), /lacks files/)
  assert.deepEqual(readAllowlist(join(dir, 'missing.json'), ['key']), [])
  const { kept, excused, stale } = splitAllowlisted(['src/a/b.ts', 'lib/c.ts'], entries, (e, rel) => globRegex(e.files[0]).test(rel))
  assert.deepEqual([kept, excused, stale.map((e) => e.reason)], [['lib/c.ts'], ['src/a/b.ts'], ['old']])
})

test('key entries: `*` spans anything, `kind:<kind>` excuses a whole kind, "kind" narrows; stale ones are findings', () => {
  const entries = [{ key: 'p:a.ts#*', reason: 'r' }, { key: 'kind:write-only', reason: 'r' }, { key: 'p:b.ts#x', kind: 'dead', reason: 'r' },
    { key: 'p:gone', reason: 'r' }].map((e) => ({ ...e, re: keyRegex(e.key) }))
  const findings = [{ key: 'p:a.ts#x.y/z', kind: 'dead' }, { key: 'p:c.ts#w', kind: 'write-only' }, { key: 'p:b.ts#x', kind: 'test-only' }]
  const { left, excused } = applyAllowlist(findings, entries)
  assert.equal(excused, 2)
  assert.deepEqual(left.map((f) => [f.kind, f.key]), [['test-only', 'p:b.ts#x'], ['stale-allowlist', 'p:b.ts#x'], ['stale-allowlist', 'p:gone']])
  assert.deepEqual(applyAllowlist(findings, entries, { reportStale: false }).left.length, 1)
})

test('one test-path rule: tests, specs, test support, fixtures and dev mocks', () => {
  for (const rel of ['lambda/api/test/test_x.py', 'src/a.test.tsx', 'lib/test-support/x.ts', 'src/x-fixtures.ts',
    'src/__fixtures__/f.ts', 'frontend/mock-server.js', 'e2e/tests/a.spec.ts', 'scripts/audit/conftest.py']) assert.ok(isTestPath(rel), rel)
  for (const rel of ['lambda/api/testing_handler.py', 'src/contest.ts', 'src/mockups/Page.tsx', 'lib/latest/x.ts']) assert.ok(!isTestPath(rel), rel)
})

test('vacuity guard: a scan that saw too little is an error, not a clean result', () => {
  assert.throws(() => checkVacuity({ name: 'p', min: { files: 10 } }, { files: 3 }), /vacuous scan/)
  assert.doesNotThrow(() => checkVacuity({ name: 'p', min: { files: 10 } }, { files: 30 }))
})
