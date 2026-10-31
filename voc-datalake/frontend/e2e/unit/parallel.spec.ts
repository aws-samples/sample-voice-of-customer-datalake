/**
 * The read-only specs (lib/parallel.ts) run fully parallel beside the writing ones, so each listed
 * spec must really write nothing: no non-GET API call (the one stateless POST excepted), no ledger
 * entry, no assistant run. And the worker counts come from the env or fail loudly.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { READ_ONLY_SPECS, READ_ONLY_SPEC_NAMES, workerPlan } from '../lib/parallel'

const TESTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests')
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
  expect(READ_ONLY_SPECS.test('tests/screens.spec.ts')).toBe(true)
  expect(READ_ONLY_SPECS.test('tests/writes.spec.ts')).toBe(false)
  expect(READ_ONLY_SPECS.test('tests/screens.spec.ts.bak')).toBe(false)
})

test('workers: 4 read + 1 write by default, overridable, and a bad value is refused', () => {
  expect(workerPlan({})).toStrictEqual({ read: 4, write: 1, total: 5 })
  expect(workerPlan({ E2E_READ_WORKERS: '6', E2E_WRITE_WORKERS: '2' })).toStrictEqual({ read: 6, write: 2, total: 8 })
  expect(() => workerPlan({ E2E_READ_WORKERS: 'many' })).toThrow(/E2E_READ_WORKERS must be a whole number/)
  expect(() => workerPlan({ E2E_WRITE_WORKERS: '0' })).toThrow(/E2E_WRITE_WORKERS/)
})
