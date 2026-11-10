// Tests for scripts/actions-lint.sh with stub actionlint / zizmor binaries: the tool-presence and
// version policy (missing or older fails, newer only notes), and that a finding in one tool fails the run
// without skipping the other. The real tools' findings are not tested here; the script runs them as-is.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('./actions-lint.sh', import.meta.url).pathname
const pinned = (name) => readFileSync(SCRIPT, 'utf8').match(new RegExp(`^${name}=(\\S+)$`, 'm'))[1]
const ACTIONLINT = pinned('ACTIONLINT_VERSION')
const ZIZMOR = pinned('ZIZMOR_VERSION')

/** A stub that prints `version` for its version flag and otherwise exits `status` after a marker line. */
function stub(dir, name, version, status = 0) {
  const path = join(dir, name)
  writeFileSync(path, [
    '#!/bin/sh',
    `case "$1" in -version|--version) echo "${name} ${version}"; exit 0;; esac`,
    `echo "${name}-ran"`,
    `exit ${status}`,
    '',
  ].join('\n'))
  chmodSync(path, 0o755)
  return path
}

function run(tools) {
  const dir = mkdtempSync(join(tmpdir(), 'actions-lint-'))
  try {
    const env = { ...process.env }
    for (const [key, spec] of Object.entries(tools)) {
      env[key] = spec === null ? join(dir, 'absent') : stub(dir, key.toLowerCase(), spec.version, spec.status)
    }
    const result = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' })
    return { status: result.status, out: result.stdout + result.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('passes when both pinned tools are present and clean', () => {
  const { status, out } = run({ ACTIONLINT: { version: ACTIONLINT }, ZIZMOR: { version: ZIZMOR } })
  assert.equal(status, 0, out)
  assert.match(out, /actionlint-ran[\s\S]*zizmor-ran[\s\S]*actions-lint: clean/)
  assert.doesNotMatch(out, /note: v/)
})

test('fails with an install hint when a tool is missing', () => {
  const { status, out } = run({ ACTIONLINT: { version: ACTIONLINT }, ZIZMOR: null })
  assert.equal(status, 127)
  // Escape every regex metacharacter (backslash included) so the pin is matched literally.
  const pinned = ZIZMOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(out, new RegExp(`zizmor: not installed\\. Install v${pinned}`))
})

test('fails on a version older than the pin', () => {
  const { status, out } = run({ ACTIONLINT: { version: '1.6.99' }, ZIZMOR: { version: ZIZMOR } })
  assert.equal(status, 127)
  assert.match(out, /actionlint: v1\.6\.99 is older than the pinned/)
})

test('only notes a newer version, comparing fields numerically (1.10.0 > 1.9.x)', () => {
  const { status, out } = run({ ACTIONLINT: { version: '1.10.0' }, ZIZMOR: { version: '99.0.0' } })
  assert.equal(status, 0, out)
  assert.match(out, /actionlint: note: v1\.10\.0, CI pins/)
  assert.match(out, /zizmor: note: v99\.0\.0, CI pins/)
})

test('a finding in the first tool fails the run but the second still runs', () => {
  const { status, out } = run({ ACTIONLINT: { version: ACTIONLINT, status: 1 }, ZIZMOR: { version: ZIZMOR } })
  assert.equal(status, 1)
  assert.match(out, /zizmor-ran/)
  assert.match(out, /actions-lint: findings above/)
})

test('a zizmor finding (exit 10-14) fails the run', () => {
  const { status } = run({ ACTIONLINT: { version: ACTIONLINT }, ZIZMOR: { version: ZIZMOR, status: 14 } })
  assert.equal(status, 1)
})
