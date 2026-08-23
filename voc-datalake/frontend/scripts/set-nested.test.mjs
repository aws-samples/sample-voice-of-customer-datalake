#!/usr/bin/env node

/**
 * Tests for the prototype-safe nested setter used by fix-i18n.mjs.
 *
 * Pins BOTH protection layers independently, so removing either one fails:
 * 1. Structural: intermediate containers are created with Object.create(null).
 *    Reverting them to `{}` literals fails these tests.
 * 2. Denylist: segments named `__proto__`, `constructor` or `prototype` are
 *    rejected before any write. Removing the early return fails the pollution
 *    matrix below (a leading `__proto__` on a prototypal root reaches
 *    Object.prototype through the accessor even when every created container
 *    is null-prototypal).
 *
 * Also pins behaviour preservation: writes land where they did before and
 * JSON.stringify output is byte-identical to containers built from plain
 * object literals, which is what keeps saveJSON output unchanged.
 *
 * Run: node scripts/set-nested.test.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'

import { setNested } from './set-nested.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const LOCALES_DIR = resolve(__dirname, '..', 'public', 'locales')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}: ${e.message}`)
  }
}

// ── Layer 1: created containers must be prototype-less ──

test('intermediate containers have null prototype', () => {
  const root = {}
  setNested(root, 'sidebar.section.title', 'Translations')
  const sidebar = Object.getOwnPropertyDescriptor(root, 'sidebar').value
  const section = Object.getOwnPropertyDescriptor(sidebar, 'section').value
  assert.equal(Object.getPrototypeOf(sidebar), null,
    'first-level container should be null-prototypal')
  assert.equal(Object.getPrototypeOf(section), null,
    'second-level container should be null-prototypal')
})

test('root object prototype is never replaced', () => {
  const root = {}
  setNested(root, 'a.b.c', 'x')
  assert.equal(Object.getPrototypeOf(root), Object.prototype)
})

test('writes still land at the expected path (own properties)', () => {
  const root = {}
  setNested(root, 'dashboard.cards.total', 'Total')
  assert.equal(root.dashboard.cards.total, 'Total')
})

test('existing subtree nodes are reused, not replaced', () => {
  const existing = { label: 'keep me' }
  const root = { settings: existing }
  setNested(root, 'settings.profile.name', 'New')
  assert.equal(root.settings, existing, 'pre-existing node identity preserved')
  assert.equal(existing.label, 'keep me')
  assert.equal(existing.profile.name, 'New')
})

test('setting an existing leaf overwrites it (last write wins)', () => {
  const root = {}
  setNested(root, 'common.ok', 'OK')
  setNested(root, 'common.ok', 'Aceptar')
  assert.equal(root.common.ok, 'Aceptar')
})

// ── Layer 2: pollution matrix (denylist) ──

const PROTO_SNAPSHOT = Object.getOwnPropertyNames(Object.prototype).sort().join(',')

const DANGEROUS_KEYS = [
  '__proto__.polluted',
  'polluted.__proto__',
  'a.__proto__.polluted',
  'constructor.polluted',
  'constructor.prototype.polluted',
  'a.constructor.polluted',
  'a.prototype.polluted',
  'prototype.polluted',
]

test('dangerous keys at any path position cannot touch Object.prototype', () => {
  for (const key of DANGEROUS_KEYS) {
    const root = {}
    setNested(root, key, 'evil')
    assert.equal(PROTO_SNAPSHOT, Object.getOwnPropertyNames(Object.prototype).sort().join(','),
      `Object.prototype changed after writing "${key}"`)
    assert.equal(({}).polluted, undefined, `global pollution after "${key}"`)
    assert.equal(({}).prototype?.polluted, undefined)
    assert.equal(({}).constructor?.polluted, undefined)
  }
})

test('dangerous keys against a pre-populated prototypal tree stay inert', () => {
  // Simulates real usage: targetData comes from JSON.parse of locale files.
  const root = JSON.parse('{"sidebar":{"label":"Sidebar"}}')
  for (const key of DANGEROUS_KEYS) {
    setNested(root, key, 'evil')
    assert.equal(PROTO_SNAPSHOT, Object.getOwnPropertyNames(Object.prototype).sort().join(','),
      `Object.prototype changed after writing "${key}"`)
    assert.equal(root.sidebar.__proto__, Object.prototype,
      `"${key}" must not rewrite an existing node's prototype`)
    assert.equal(Object.getOwnPropertyDescriptor(root.sidebar, '__proto__'), undefined,
      `"${key}" must not create an own "__proto__" property`)
  }
  assert.equal(root.sidebar.label, 'Sidebar', 'untouched sibling data intact')
})

test('denied keys write nothing anywhere in the tree', () => {
  const root = { deep: {} }
  setNested(root, 'deep.__proto__', 'evil')
  assert.deepEqual(Object.keys(root.deep), [], 'no property created under denied segment')
  setNested(root, '__proto__', 'evil')
  assert.deepEqual(Object.keys(root), ['deep'], 'no own "__proto__" on root')
})

// ── Behaviour preservation: serialization is byte-identical ──

test('JSON.stringify of built tree equals plain-literal tree byte for byte', () => {
  const built = {}
  setNested(built, 'actions.close', 'Close')
  setNested(built, 'appName', 'VoC Analytics')
  setNested(built, 'sidebar.section.title', 'Titles')
  setNested(built, 'sidebar.messagesCount', 'Messages')

  const expected = {
    actions: { close: 'Close' },
    appName: 'VoC Analytics',
    sidebar: { section: { title: 'Titles' }, messagesCount: 'Messages' },
  }

  // Same format as saveJSON: 2-space indent plus trailing newline.
  assert.equal(JSON.stringify(built, null, 2) + '\n',
    JSON.stringify(expected, null, 2) + '\n')
})

test('round trip through a real locale file stays byte-identical', () => {
  // loadJSON -> setNested a fresh key (in memory only) -> saveJSON format.
  // The same addition expressed as a plain literal must serialize identically;
  // this is what guarantees generated locale files do not change shape.
  const file = resolve(LOCALES_DIR, 'en', 'common.json')
  const parsed = JSON.parse(readFileSync(file, 'utf-8'))
  assert.ok(!('brandNewKeyFromTest' in parsed), 'fixture key must not already exist')

  const viaSetter = JSON.parse(JSON.stringify(parsed))
  setNested(viaSetter, 'brandNewKeyFromTest.value', 'hello')

  const viaLiteral = JSON.parse(JSON.stringify(parsed))
  viaLiteral.brandNewKeyFromTest = { value: 'hello' }

  assert.equal(
    JSON.stringify(viaSetter, null, 2) + '\n',
    JSON.stringify(viaLiteral, null, 2) + '\n',
  )
})

console.log(`\nset-nested regression tests: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
