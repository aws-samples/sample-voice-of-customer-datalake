#!/usr/bin/env node
/* eslint-disable security/detect-non-literal-fs-filename -- test script with controlled paths */

/**
 * Regression tests for i18n translation quality.
 *
 * Verifies:
 * 1. Plural keys in categories.json have proper translations (not English key names)
 * 2. The untranslated detection logic correctly identifies values identical to English
 */

import { readFileSync } from 'node:fs'
import { resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const LOCALES_DIR = resolve(__dirname, '..', 'public', 'locales')

function safePath(base, ...segments) {
  const resolved = normalize(resolve(base, ...segments))
  if (!resolved.startsWith(normalize(base) + '/') && resolved !== normalize(base)) {
    throw new Error(`Path traversal detected: ${resolved} is outside ${base}`)
  }
  return resolved
}

function loadLocale(lang, ns) {
  return JSON.parse(readFileSync(safePath(LOCALES_DIR, lang, `${ns}.json`), 'utf-8'))
}

function flattenEntries(obj, prefix = '') {
  const entries = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...flattenEntries(value, fullKey))
    } else {
      entries.push([fullKey, value])
    }
  }
  return entries
}

const LANGUAGES = ['es', 'fr', 'de', 'ko', 'ja', 'zh', 'pt']
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

// ── Test: plural keys in categories.json must not be English key names ──

const PLURAL_KEYS_TO_CHECK = [
  'issuesWithPercent_one',
  'issuesWithPercent_other',
  'mentionsTooltip_one',
  'mentionsTooltip_other',
  'starsMin_one',
  'starsMin_other',
]

for (const lang of LANGUAGES) {
  const data = loadLocale(lang, 'categories')
  const flat = new Map(flattenEntries(data))

  for (const key of PLURAL_KEYS_TO_CHECK) {
    test(`${lang}/categories.json: ${key} is not an English key name`, () => {
      const value = flat.get(key)
      assert.ok(value, `Key "${key}" should exist`)
      // The bug was values like "issuesWithPercent" or "starsMin" — the English key name as the value
      const keyBase = key.replace(/_one$|_other$|_many$/, '')
      assert.notEqual(value, keyBase, `Value should not be the English key name "${keyBase}"`)
      assert.notEqual(value, key, `Value should not be the key itself "${key}"`)
    })
  }

  test(`${lang}/categories.json: issuesWithPercent_one contains {{count}} template`, () => {
    const value = flat.get('issuesWithPercent_one')
    assert.ok(value?.includes('{{count}}'), `Should contain {{count}} interpolation, got: "${value}"`)
    assert.ok(value?.includes('{{percent}}'), `Should contain {{percent}} interpolation, got: "${value}"`)
  })

  test(`${lang}/categories.json: mentionsTooltip_one contains {{count}} template`, () => {
    const value = flat.get('mentionsTooltip_one')
    assert.ok(value?.includes('{{count}}'), `Should contain {{count}} interpolation, got: "${value}"`)
  })

  test(`${lang}/categories.json: starsMin_one contains {{count}} template`, () => {
    const value = flat.get('starsMin_one')
    assert.ok(value?.includes('{{count}}'), `Should contain {{count}} interpolation, got: "${value}"`)
  })
}

// ── Test: projectDetail must be in fix-i18n.mjs NAMESPACES ──
// This was the root cause of projectDetail.json being untranslated across 6 locales.

test('fix-i18n.mjs NAMESPACES includes projectDetail', () => {
  const fixScript = readFileSync(
    resolve(__dirname, 'fix-i18n.mjs'), 'utf-8'
  )
  assert.ok(
    fixScript.includes("'projectDetail'"),
    'fix-i18n.mjs NAMESPACES array must include projectDetail'
  )
})

console.log(`\ni18n regression tests: ${passed} passed, ${failed} failed`)
/* eslint-enable security/detect-non-literal-fs-filename */
process.exit(failed > 0 ? 1 : 0)
