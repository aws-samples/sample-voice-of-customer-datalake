/**
 * The read-only specs (lib/parallel.ts) run fully parallel beside the writing ones, so each listed
 * spec must really write nothing: no non-GET API call (the one stateless POST excepted), no ledger
 * entry, no assistant run. And the worker counts come from the env or fail loudly.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { READ_ONLY_SPECS, READ_ONLY_SPEC_NAMES, shardWorkerPlan, workerPlan } from '../lib/parallel'

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TESTS_DIR = path.join(E2E_ROOT, 'tests')
// POST /workflows/validate stores nothing (agents_handler); the only non-GET call a read-only spec may make.
const STATELESS_POST = /apiCall\([^\n]*?(['"`])POST\1,\s*(['"`])\/workflows\/validate\2/g
// Every lib/assistant.ts helper that starts (or counts, or resets) an assistant run, as in
// unit/conversation-cap.spec.ts: a read-only spec calls none of them.
const ASSISTANT_RUN_HELPERS = ['ask', 'askAssistant', 'sendOnly', 'approve', 'decline', 'newChat', 'countRun'] as const
// A write verb in any JS quote style ('…', "…", `…`), as apiCall-style helpers take it.
const WRITES = new RegExp(`(['"\`])(?:POST|PUT|PATCH|DELETE)\\1|recordCreated\\(|\\b(?:${ASSISTANT_RUN_HELPERS.join('|')})\\(`)

test('every listed spec exists and none of them writes', () => {
  const writing = READ_ONLY_SPEC_NAMES.filter((name) => {
    const source = fs.readFileSync(path.join(TESTS_DIR, `${name}.spec.ts`), 'utf8')
    return WRITES.test(source.replace(STATELESS_POST, ''))
  })
  expect(writing).toStrictEqual([])
})

test('the write guard catches every assistant-run helper and each write verb', () => {
  for (const helper of ASSISTANT_RUN_HELPERS) expect(WRITES.test(`await ${helper}(page)`), helper).toBe(true)
  expect(WRITES.test("apiCall(request, 'DELETE', '/x')")).toBe(true)
  expect(WRITES.test('apiCall(request, "PUT", "/x")')).toBe(true)
  expect(WRITES.test('apiCall(request, `PATCH`, `/x`)')).toBe(true)
  expect(WRITES.test('apiCall(request, "GET", "/projects")')).toBe(false)
  // Mismatched quotes are not a verb literal.
  expect(WRITES.test(`apiCall(request, 'POST", '/x')`)).toBe(false)
  // Only the stateless validate POST is allowed, in any quote style.
  for (const call of ["apiCall(request, 'POST', '/workflows/validate')", 'apiCall(request, "POST", "/workflows/validate")', 'apiCall(request, `POST`, `/workflows/validate`)']) {
    expect(WRITES.test(call.replace(STATELESS_POST, '')), call).toBe(false)
  }
  expect(WRITES.test('apiCall(request, "POST", "/workflows")'.replace(STATELESS_POST, ''))).toBe(true)
  expect(WRITES.test('recordCreated(ledger, id)')).toBe(true)
  expect(WRITES.test("apiCall(request, 'GET', '/projects')")).toBe(false)
  expect(WRITES.test('await page.getByRole("button", { name: "Decline" }).isVisible()')).toBe(false)
  expect(WRITES.test('await openFloating(page)')).toBe(false)
})

test('the pattern matches exactly the listed specs', () => {
  expect(READ_ONLY_SPECS.test('tests/request-counts.spec.ts')).toBe(true)
  expect(READ_ONLY_SPECS.test('tests/writes.spec.ts')).toBe(false)
  expect(READ_ONLY_SPECS.test('tests/request-counts.spec.ts.bak')).toBe(false)
  // They read entities a concurrent write spec may delete or totals it may change (lib/parallel.ts).
  for (const racing of ['screens', 'api-sweep', 'dashboard-data', 'prioritization-requests']) {
    expect(READ_ONLY_SPECS.test(`tests/${racing}.spec.ts`), racing).toBe(false)
  }
})

test('workers: 4 read + 1 write by default, overridable, and a bad value is refused', () => {
  expect(workerPlan({})).toStrictEqual({ read: 4, write: 1, total: 5 })
  expect(workerPlan({ E2E_READ_WORKERS: '6', E2E_WRITE_WORKERS: '2' })).toStrictEqual({ read: 6, write: 2, total: 8 })
  expect(() => workerPlan({ E2E_READ_WORKERS: 'many' })).toThrow(/E2E_READ_WORKERS must be a whole number/)
  expect(() => workerPlan({ E2E_WRITE_WORKERS: '0' })).toThrow(/E2E_WRITE_WORKERS/)
})

test('shard workers: 2 + 2 by default, a total alone keeps writes at 2 at most and never exceeds the total', () => {
  expect(shardWorkerPlan({})).toStrictEqual({ read: 2, write: 2, total: 4 })
  expect(shardWorkerPlan({ E2E_SHARD_READ_WORKERS: '5' })).toStrictEqual({ read: 5, write: 2, total: 7 })
  expect(shardWorkerPlan({ E2E_SHARD_WORKERS: '6' })).toStrictEqual({ read: 4, write: 2, total: 6 })
  expect(shardWorkerPlan({ E2E_SHARD_WORKERS: '3' })).toStrictEqual({ read: 1, write: 2, total: 3 })
  expect(shardWorkerPlan({ E2E_SHARD_WORKERS: '2' })).toStrictEqual({ read: 1, write: 1, total: 2 })
  // One worker: both projects share it (Playwright's --workers=1 runs one test at a time).
  expect(shardWorkerPlan({ E2E_SHARD_WORKERS: '1' })).toStrictEqual({ read: 1, write: 1, total: 1 })
  for (const total of [2, 3, 4, 8, 16]) {
    const plan = shardWorkerPlan({ E2E_SHARD_WORKERS: String(total) })
    expect(plan.write, `total ${total}`).toBeLessThanOrEqual(2)
    expect(plan.read + plan.write, `total ${total}`).toBeLessThanOrEqual(total)
  }
  // An explicit cap with a total: the other cap gets the rest.
  expect(shardWorkerPlan({ E2E_SHARD_WORKERS: '8', E2E_SHARD_WRITE_WORKERS: '3' })).toStrictEqual({ read: 5, write: 3, total: 8 })
  expect(shardWorkerPlan({ E2E_SHARD_WORKERS: '8', E2E_SHARD_READ_WORKERS: '7' })).toStrictEqual({ read: 7, write: 2, total: 8 })
})

test('shard workers: a cap above the total or a bad value is refused', () => {
  expect(() => shardWorkerPlan({ E2E_SHARD_WORKERS: '2', E2E_SHARD_WRITE_WORKERS: '3' }))
    .toThrow(/E2E_SHARD_WRITE_WORKERS=3 is more than E2E_SHARD_WORKERS=2/)
  expect(() => shardWorkerPlan({ E2E_SHARD_WORKERS: '4', E2E_SHARD_READ_WORKERS: '9' }))
    .toThrow(/E2E_SHARD_READ_WORKERS=9 is more than E2E_SHARD_WORKERS=4/)
  expect(() => shardWorkerPlan({ E2E_SHARD_WORKERS: 'all' })).toThrow(/E2E_SHARD_WORKERS must be a whole number/)
})

test('run-sharded.sh takes its workers from shardWorkerPlan and stops on an inconsistent combination', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'voc-e2e-shard-'))
  const run = spawnSync('bash', ['scripts/run-sharded.sh', '1'], {
    cwd: E2E_ROOT,
    env: { ...process.env, E2E_SHARD_OUT: out, E2E_SHARD_WORKERS: '2', E2E_SHARD_WRITE_WORKERS: '3' },
    encoding: 'utf8',
  })
  expect(run.status).toBe(2)
  expect(run.stderr).toContain('E2E_SHARD_WRITE_WORKERS=3 is more than E2E_SHARD_WORKERS=2')
  // Refused before any shard started.
  expect(fs.existsSync(path.join(out, 'shard1'))).toBe(false)
})
