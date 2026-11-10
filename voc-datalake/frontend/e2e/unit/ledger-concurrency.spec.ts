/**
 * Workers of one shard share `created.json`. Before the ledger lock, two processes appending at
 * the same moment could each read the old list and write their own copy, so one entry was lost,
 * and a lost entry is prod data the teardown never deletes. Several processes now append to one
 * JSON list at once under `withFileLock` (what `recordCreated` holds), and every entry survives.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const E2E_ROOT = path.resolve(HERE, '..')
const WRITERS = 6
const PER_WRITER = 15

/** One child process appending PER_WRITER ids to `<out>/created.json`, read-modify-write under the lock. */
function writer(out: string, index: number): Promise<number> {
  const file = path.join(out, 'created.json')
  const script = [
    "import fs from 'node:fs'",
    "import { withFileLock } from './lib/fileLock.ts'",
    `const file = ${JSON.stringify(file)}`,
    `for (let i = 0; i < ${PER_WRITER}; i += 1) withFileLock(file + '.lock', () => {`,
    "  const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []",
    `  fs.writeFileSync(file + '.tmp', JSON.stringify([...list, { id: 'w${index}_' + i }]))`,
    "  fs.renameSync(file + '.tmp', file)",
    '})',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      cwd: E2E_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(code) : reject(new Error(`writer ${index} exited ${code}: ${stderr.slice(0, 400)}`))))
  })
}

test('concurrent writers under the ledger lock lose no entry', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ledger-lock-'))
  try {
    await Promise.all(Array.from({ length: WRITERS }, (_unused, index) => writer(out, index)))
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(out, 'created.json'), 'utf8'))
    expect(Array.isArray(raw)).toBe(true)
    const ids = new Set(Array.isArray(raw) ? raw.map((entry: { id?: unknown }) => entry.id) : [])
    expect(ids.size).toBe(WRITERS * PER_WRITER)
    expect(fs.existsSync(path.join(out, 'created.json.lock'))).toBe(false)
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})
