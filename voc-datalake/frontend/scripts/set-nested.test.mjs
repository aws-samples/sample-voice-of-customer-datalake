#!/usr/bin/env node

/**
 * Tests for the prototype-safe nested setter used by fix-i18n.mjs (set-nested.mjs).
 *
 * Each protection is pinned on its own, so removing either fails a case: the refusal of
 * `__proto__` / `constructor` / `prototype` segments, and the null-prototype, own-only
 * containers. Also pinned: writes land where they always did and serialise byte-identically,
 * which keeps the locale files fix-i18n.mjs saves unchanged.
 *
 * Ported from the tests proposed in PR #370.
 *
 * Run: node --test scripts/set-nested.test.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { setNested } from './set-nested.mjs'

const LOCALES_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'public', 'locales')

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

const prototypeNames = () => Object.getOwnPropertyNames(Object.prototype).sort().join(',')

/** Asserts Object.prototype looks exactly as it did before `key` was written. */
function assertPrototypeIntact(before, key) {
  assert.equal(prototypeNames(), before, `Object.prototype changed after writing "${key}"`)
  assert.equal(({}).polluted, undefined, `every object sees "polluted" after "${key}"`)
  assert.equal(Object.polluted, undefined, `Object (the constructor) changed after "${key}"`)
}

describe('setNested: keys naming the prototype chain', () => {
  it('leaves Object.prototype untouched for a dangerous segment at any position', () => {
    const before = prototypeNames()
    for (const key of DANGEROUS_KEYS) {
      setNested({}, key, 'evil')
      assertPrototypeIntact(before, key)
    }
  })

  it('leaves Object.prototype and existing nodes untouched in a parsed locale tree', () => {
    const before = prototypeNames()
    const root = JSON.parse('{"sidebar":{"label":"Sidebar"}}')
    for (const key of DANGEROUS_KEYS) {
      setNested(root, key, 'evil')
      assertPrototypeIntact(before, key)
      assert.equal(Object.getPrototypeOf(root.sidebar), Object.prototype)
    }
    assert.equal(JSON.stringify(root), '{"sidebar":{"label":"Sidebar"}}')
  })

  it('writes nothing, not even the containers before the dangerous segment', () => {
    for (const key of DANGEROUS_KEYS) {
      const root = { deep: {} }
      setNested(root, key, 'evil')
      assert.deepEqual(Object.keys(root), ['deep'], `"${key}" created a top-level key`)
      assert.deepEqual(Object.keys(root.deep), [], `"${key}" wrote under an existing node`)
      assert.equal(Object.getOwnPropertyDescriptor(root, '__proto__'), undefined)
    }
  })
})

describe('setNested: containers it creates', () => {
  it('creates null-prototype containers at every level and keeps the root prototype', () => {
    const root = {}
    setNested(root, 'sidebar.section.title', 'Translations')
    assert.equal(Object.getPrototypeOf(root), Object.prototype)
    assert.equal(Object.getPrototypeOf(root.sidebar), null)
    assert.equal(Object.getPrototypeOf(root.sidebar.section), null)
    assert.equal(root.sidebar.section.title, 'Translations')
  })

  it('reuses an existing own node and keeps its other keys', () => {
    const existing = { label: 'keep me' }
    const root = { settings: existing }
    setNested(root, 'settings.profile.name', 'New')
    assert.equal(root.settings, existing)
    assert.equal(existing.label, 'keep me')
    assert.equal(existing.profile.name, 'New')
  })

  it('never descends into an inherited node', () => {
    const inherited = { settings: { label: 'from prototype' } }
    const root = Object.create(inherited)
    setNested(root, 'settings.profile.name', 'New')
    assert.ok(Object.hasOwn(root, 'settings'))
    assert.equal(inherited.settings.profile, undefined, 'the prototype subtree was written')
    assert.equal(root.settings.profile.name, 'New')
  })

  it('replaces a leaf on a second write', () => {
    const root = {}
    setNested(root, 'common.ok', 'OK')
    setNested(root, 'common.ok', 'Aceptar')
    assert.equal(root.common.ok, 'Aceptar')
  })
})

describe('setNested: saved output', () => {
  it('serialises byte-identically to the same tree built from object literals', () => {
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
    assert.equal(JSON.stringify(built, null, 2), JSON.stringify(expected, null, 2))
  })

  it('keeps a real locale file byte-identical apart from the added key', () => {
    const parsed = JSON.parse(readFileSync(resolve(LOCALES_DIR, 'en', 'common.json'), 'utf-8'))
    assert.ok(!('brandNewKeyFromTest' in parsed), 'fixture key must not already exist')
    const viaSetter = structuredClone(parsed)
    setNested(viaSetter, 'brandNewKeyFromTest.value', 'hello')
    const viaLiteral = { ...structuredClone(parsed), brandNewKeyFromTest: { value: 'hello' } }
    assert.equal(JSON.stringify(viaSetter, null, 2), JSON.stringify(viaLiteral, null, 2))
  })
})
