// run-all.sh discovers detectors by their `audit-detector:` marker (libraries, aggregators and tests carry none), rolls their exit codes up and
// writes a summary, passing --json only to detectors that advertise it. Fake detectors in a temp tree.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempTree } from './ts_audit_fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const fakeRepo = (detectors) => tempTree(Object.fromEntries([['run-all.sh', readFileSync(join(HERE, 'run-all.sh'), 'utf8')],
  ...Object.entries(detectors)].map(([name, text]) => [`scripts/audit/${name}`, text])), 'audit-run-all-')

const pyDetector = (code, withJson = false) => `# audit-detector: fake
import sys
if '--help' in sys.argv:
    print('usage: x ${withJson ? '[--json PATH]' : ''}')
    sys.exit(0)
if '--json' in sys.argv:
    open(sys.argv[sys.argv.index('--json') + 1], 'w').write('{"findings": []}')
print('py detector headline')
print('detail line')
sys.exit(${code})
`
const mjsDetector = (code) => `// audit-detector: fake
if (process.argv.includes('--help')) { console.log('usage'); process.exit(0) }
console.log('mjs detector headline'); process.exit(${code})
`

function runAll(root, ...args) {
  return spawnSync('bash', [join(root, 'scripts', 'audit', 'run-all.sh'), ...args], {
    encoding: 'utf8', env: { ...process.env, PYTHON_BIN: 'python3', AUDIT_OUT: join(root, 'out') },
  })
}

test('--list names detectors only: libraries, aggregators and tests (no marker) are skipped', () => {
  const root = fakeRepo({
    'py_dead.py': pyDetector(0), 'ts_dead.mjs': mjsDetector(0), '_lib.py': '', '_lib.mjs': '',
    'audit_common.py': 'import sys\n', 'audit_common.mjs': 'export const x = 1\n', 'aggregate.py': '# runs the others\n',
    'test_py_dead.py': '# audit-detector: a test that mentions it\n', 'ts_dead.test.mjs': '// audit-detector: test\n',
  })
  const { stdout, status } = runAll(root, '--list')
  assert.equal(status, 0)
  assert.deepEqual(stdout.trim().split('\n').sort(), ['scripts/audit/py_dead.py', 'scripts/audit/ts_dead.mjs'])
})

test('all clean exits 0 and writes the summary; --json goes only to detectors that advertise it', () => {
  const root = fakeRepo({ 'a.py': pyDetector(0, true), 'b.mjs': mjsDetector(0) })
  const { status, stdout } = runAll(root)
  assert.equal(status, 0, stdout)
  const summary = JSON.parse(readFileSync(join(root, 'out', 'summary.json'), 'utf8'))
  assert.deepEqual(summary.map((s) => [s.detector, s.exit]).sort(), [['a.py', 0], ['b.mjs', 0]])
  assert.ok(existsSync(join(root, 'out', 'a.py.json')))
  assert.ok(!existsSync(join(root, 'out', 'b.mjs.json')))
  assert.match(stdout, /a\.py\s+clean/)
})

test('one detector with findings makes the run exit 1 and prints its excerpt', () => {
  const root = fakeRepo({ 'a.py': pyDetector(1), 'b.mjs': mjsDetector(0) })
  const { status, stdout } = runAll(root)
  assert.equal(status, 1)
  assert.match(stdout, /a\.py\s+FINDINGS/)
  assert.match(stdout, /detail line/)
})

test('a detector that cannot run makes the run exit 2, even beside findings', () => {
  const root = fakeRepo({ 'a.py': pyDetector(1), 'b.mjs': mjsDetector(2) })
  const { status, stdout } = runAll(root)
  assert.equal(status, 2)
  assert.match(stdout, /b\.mjs\s+ERROR\(2\)/)
})

test('no detector at all is an error, not a clean run', () => {
  assert.equal(runAll(fakeRepo({ '_lib.py': '' })).status, 2)
})
