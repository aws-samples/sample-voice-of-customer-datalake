// Every REAL detector run-all.sh discovers keeps the CLI contract (docs/code-audit.md): `--help` prints a usage
// that offers `--json` and exits 0. Fast: no detector scans anything for --help.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './audit_common.mjs'

const venvPython = join(REPO_ROOT, 'voc-datalake', '.venv', 'bin', 'python')
const PYTHON = process.env.PYTHON_BIN ?? (existsSync(venvPython) ? venvPython : 'python3')

const listed = spawnSync('bash', [join(REPO_ROOT, 'scripts', 'audit', 'run-all.sh'), '--list'], { encoding: 'utf8' })
const detectors = listed.stdout.trim().split('\n').filter(Boolean)

test('run-all discovers a plausible number of detectors', () => {
  assert.equal(listed.status, 0, listed.stderr)
  assert.ok(detectors.length >= 12, `only ${detectors.length} detectors: ${detectors.join(', ')}`)
})

for (const detector of detectors) {
  test(`${detector} --help exits 0 and offers --json`, () => {
    const runner = detector.endsWith('.py') ? PYTHON : process.execPath
    const { status, stdout, stderr } = spawnSync(runner, [join(REPO_ROOT, detector), '--help'], { encoding: 'utf8', cwd: REPO_ROOT })
    assert.equal(status, 0, stderr)
    assert.match(stdout, /--json/)
  })
}
