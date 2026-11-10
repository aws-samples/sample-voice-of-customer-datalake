/**
 * Saved sessions follow the run's output directory, so parallel runs (shards of
 * scripts/run-sharded.sh, QA tracks) never overwrite each other's `<role>.json`
 * (5.35 prod run: shards landed on /login with "No id token in the saved admin session").
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { AUTH_DIR, OUT_DIR, authDirFor, ensureAuthDir, removesAuthAfterRun, storageStatePath } from '../lib/env'

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('two runs with their own E2E_OUT keep their sessions apart', () => {
  const one = authDirFor({ E2E_OUT: '/tmp/e2e-run/shard1' })
  const two = authDirFor({ E2E_OUT: '/tmp/e2e-run/shard2' })
  expect(one).toBe(path.resolve('/tmp/e2e-run/shard1/.auth'))
  expect(two).not.toBe(one)
})

test('E2E_AUTH_DIR wins over E2E_OUT; neither set falls back to e2e/.auth', () => {
  expect(authDirFor({ E2E_AUTH_DIR: '/tmp/sessions', E2E_OUT: '/tmp/out' })).toBe(path.resolve('/tmp/sessions'))
  expect(authDirFor({ E2E_OUT: '  ' })).toBe(path.join(E2E_ROOT, '.auth'))
  expect(authDirFor({})).toBe(path.join(E2E_ROOT, '.auth'))
})

test('this run saves its sessions under its own E2E_OUT, owner-only', () => {
  expect(AUTH_DIR).toBe(path.join(OUT_DIR, '.auth'))
  expect(storageStatePath('admin')).toBe(path.join(OUT_DIR, '.auth', 'admin.json'))
  ensureAuthDir()
  expect(fs.statSync(AUTH_DIR).mode & 0o777).toBe(0o700)
})

test('a run deletes the sessions it saved in its own folder once its cleanup ends', () => {
  expect(removesAuthAfterRun({})).toBe(true)
  expect(removesAuthAfterRun({ E2E_OUT: '/tmp/e2e-run/shard1' })).toBe(true)
  expect(removesAuthAfterRun({ E2E_AUTH_DIR: '  ' })).toBe(true)
})

test('sessions in a folder the caller named, or with E2E_KEEP_AUTH=1, are kept', () => {
  expect(removesAuthAfterRun({ E2E_AUTH_DIR: '/tmp/sessions' })).toBe(false)
  expect(removesAuthAfterRun({ E2E_KEEP_AUTH: '1' })).toBe(false)
  expect(removesAuthAfterRun({ E2E_KEEP_AUTH: '0' })).toBe(true)
})

test('a session saved under an in-repo output directory is gitignored', () => {
  for (const file of ['.auth/admin.json', 'e2e-output/.auth/user.json', 'e2e-output/shard3/.auth/admin.json']) {
    const ignored = spawnSync('git', ['check-ignore', '-q', file], { cwd: E2E_ROOT })
    expect(ignored.status, file).toBe(0)
  }
})

test('the sharded runner refuses a bad shard count before it starts anything', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'voc-e2e-shard-'))
  // 17: one past the runner's cap of 16 shards.
  for (const bad of ['0', 'x', '17']) {
    const run = spawnSync('bash', ['scripts/run-sharded.sh', bad], { cwd: E2E_ROOT, env: { ...process.env, E2E_SHARD_OUT: out } })
    expect(run.status, bad).toBe(2)
    expect(String(run.stderr)).toContain('usage')
  }
  expect(fs.readdirSync(out)).toEqual([])
  fs.rmSync(out, { recursive: true, force: true })
  execFileSync('bash', ['-n', 'scripts/run-sharded.sh'], { cwd: E2E_ROOT })
})
