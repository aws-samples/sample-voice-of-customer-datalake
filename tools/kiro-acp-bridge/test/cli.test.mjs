import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 10_000 })

describe('cli', () => {
  it('prints usage and exits 0 for --help', () => {
    const result = run('--help')
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage: kiro-acp-bridge --workspace/)
  })

  for (const port of ['0', '70000', 'abc', '8765.5']) {
    it(`exits 2 for --port ${port}`, () => {
      const result = run('--port', port)
      assert.equal(result.status, 2)
      assert.match(result.stderr, /Invalid --port/)
    })
  }

  for (const seconds of ['0', '-5', 'never']) {
    it(`exits 2 for --permission-timeout ${seconds}`, () => {
      const result = run(`--permission-timeout=${seconds}`)
      assert.equal(result.status, 2)
      assert.match(result.stderr, /Invalid --permission-timeout/)
    })
  }

  it('exits 2 for an unknown flag such as --trust-all-tools (no way to pass it through)', () => {
    const result = run('--trust-all-tools')
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Unknown option/)
  })

  it('exits 1 without printing a token when the workspace does not exist', () => {
    const result = run('--workspace', join(tmpdir(), `missing-${Date.now()}`), '--port', '18799')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /kiro-acp-bridge failed/)
    assert.doesNotMatch(result.stdout, /token/)
  })
})
