#!/usr/bin/env node

/**
 * Regression tests for i18n translation quality.
 *
 * Verifies:
 * 1. Plural keys in categories.json have proper translations (not English key names)
 * 2. The untranslated detection logic correctly identifies values identical to English
 * 3. Source-key extraction resolves namespaces the way i18next does (i18n-keys.mjs)
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { flattenEntries, loadLocale, stripPlaceholders } from './i18n-locales.mjs'
import { extractKeyUsages, isValidPluralVariant, resolveKeyUsages } from './i18n-keys.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

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

// ── Test: source-key extraction resolves the namespace i18next would use ──
// These pin the false positives the regex extractor raised against the base tree
// (`assistant:header.back`, `projectDetail:prototypeLink.*`, `prioritization:...`).

const EXTRACT_OPTS = { defaultNs: 'common', namespaces: ['assistant', 'common', 'components', 'projectDetail', 'projects'] }
const extract = (content, file = 'Example.tsx') => extractKeyUsages(file, content, EXTRACT_OPTS)

test('extract: a namespace array is kept in lookup order', () => {
  const usages = extract(`function A() { const { t } = useTranslation(['projectDetail', 'projects']); return t('header.back') }`)
  assert.deepEqual(usages, [{ namespaces: ['projectDetail', 'projects'], key: 'header.back' }])
})

test('extract: each component resolves through its OWN hook, not the file\'s first one', () => {
  const usages = extract(`
    function A() { const { t } = useTranslation('assistant'); return t('launcher.ask') }
    function B() { const { t } = useTranslation('components'); return t('prototypeLink.openNewTab') }
  `)
  assert.deepEqual(usages, [
    { namespaces: ['assistant'], key: 'launcher.ask' },
    { namespaces: ['components'], key: 'prototypeLink.openNewTab' },
  ])
})

test('extract: an ns-prefixed key and an explicit ns option override the hook', () => {
  const usages = extract(`function A() { const { t } = useTranslation('projectDetail'); t('projects:sharing.share'); t('cancel', { ns: 'common' }); t('x', { ns: ['assistant', 'common'] }) }`)
  assert.deepEqual(usages, [
    { namespaces: ['projects'], key: 'sharing.share' },
    { namespaces: ['common'], key: 'cancel' },
    { namespaces: ['assistant', 'common'], key: 'x' },
  ])
})

test('extract: both branches of a static conditional key are usages (E2E s2 F2)', () => {
  // `t(x ? 'a' : 'b')` hid two missing keys that rendered as raw paths in the workflow editor.
  const usages = extract(`function A() { const { t } = useTranslation('projects'); return t(custom ? 'fields.required' : ('fields.optional')) }`)
  assert.deepEqual(usages, [
    { namespaces: ['projects'], key: 'fields.required' },
    { namespaces: ['projects'], key: 'fields.optional' },
  ])
  // A conditional with any dynamic branch stays dynamic (no partial guess).
  assert.deepEqual(extract(`function A() { const { t } = useTranslation('projects'); return t(x ? 'fields.a' : name) }`), [])
})

test('extract: keyPrefix applies to the hook\'s keys, aliases are followed', () => {
  const usages = extract(`function A() { const { t: tc } = useTranslation('components', { keyPrefix: 'manager' }); return tc('title') }`)
  assert.deepEqual(usages, [{ namespaces: ['components'], key: 'manager.title' }])
})

test('extract: comments, dynamic keys and unrelated calls are not usages', () => {
  const usages = extract(`
    /** The \`t('...')\` key stays a literal at the call site. */
    // t('commented.out')
    function A({ id }) { const { t } = useTranslation('common'); t(\`row.\${id}\`); t(id); format('x'); return null }
  `)
  assert.deepEqual(usages, [])
})

test('extract: an unbound t (helper parameter, i18n.t) falls back to the file\'s first hook', () => {
  const usages = extract(`
    function label(t) { return t('helper.label') }
    function A() { const { t, i18n } = useTranslation('components'); return i18n.t('member.key') }
  `)
  assert.deepEqual(usages, [
    { namespaces: ['components'], key: 'helper.label' },
    { namespaces: ['components'], key: 'member.key' },
  ])
})

test('extract: a file without hooks uses the default namespace', () => {
  assert.deepEqual(extract(`export const x = (t) => t('nav.home')`, 'util.ts'), [{ namespaces: ['common'], key: 'nav.home' }])
})

test('extract: a t prop typed TFunction<\'ns\'> resolves to that namespace, ahead of the file\'s first hook', () => {
  const usages = extract(`
    interface Props { readonly t: TFunction<'projectDetail'> }
    function View({ t }: Props) { return t('documents.prototype.feedbackTitle') }
    function Other() { const { t } = useTranslation('components'); return t('prototypeLink.openNewTab') }
    function Pair({ t }: { t: TFunction<['assistant', 'common']> }) { return null }
  `)
  assert.deepEqual(usages, [
    { namespaces: ['projectDetail'], key: 'documents.prototype.feedbackTitle' },
    { namespaces: ['components'], key: 'prototypeLink.openNewTab' },
  ])
})

test('extract: an untyped TFunction prop still falls back to the hook / default namespace', () => {
  assert.deepEqual(
    extract(`function V({ t }: { t: TFunction }) { return t('x.y') }`),
    [{ namespaces: ['common'], key: 'x.y' }],
  )
})

test('resolve: a namespace array finds the key in a later namespace; plural bases count', () => {
  const english = new Map([
    ['projectDetail', new Set(['title'])],
    ['projects', new Set(['header.back', 'items_one', 'items_other'])],
  ])
  const { used, missing } = resolveKeyUsages([
    { namespaces: ['projectDetail', 'projects'], key: 'header.back' },
    { namespaces: ['projectDetail', 'projects'], key: 'title' },
    { namespaces: ['projects'], key: 'items' },
    { namespaces: ['projectDetail', 'projects'], key: 'nowhere' },
    { namespaces: ['projects'], key: 'dynamic.{{x}}' },
  ], english)
  assert.deepEqual([...used].sort(), ['projectDetail:title', 'projects:header.back', 'projects:items'])
  assert.deepEqual(missing, ['projectDetail:nowhere'])
})

test('plural variants: a locale may pluralise a key English keeps plain', () => {
  const english = new Set(['showTop', 'items_one', 'items_other'])
  assert.equal(isValidPluralVariant('showTop_other', english), true)
  assert.equal(isValidPluralVariant('items_many', english), true)
  assert.equal(isValidPluralVariant('unknown_other', english), false)
  assert.equal(isValidPluralVariant('showTop', english), false)
})

test('stripPlaceholders removes every {{var}} and keeps the rest', () => {
  assert.equal(stripPlaceholders('{{count}} / {{max}}'), ' / ')
  assert.equal(stripPlaceholders('{{count}}'), '')
  assert.equal(stripPlaceholders('Show top {{count}} items'), 'Show top  items')
  assert.equal(stripPlaceholders('unclosed {{count'), 'unclosed {{count')
  assert.equal(stripPlaceholders('no vars'), 'no vars')
})

console.log(`\ni18n regression tests: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
