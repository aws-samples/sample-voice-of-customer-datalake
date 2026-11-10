import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteKeys, deleteNested, isReached, unusedKeys } from './ts_locale_keys.mjs'
import { REPO_ROOT } from './audit_common.mjs'

const EN = {
  common: {
    used: 'Used', held: 'Held', viaNs: 'Ns', dead: 'Dead',
    surfaces: { chat: { label: 'Chat' } },
    jobs: { types: { research: 'R' } },
    group: { a: 'A', b: 'B' },
    items_one: '{{count}} item', items_other: '{{count}} items',
    gone_one: 'one', gone_other: 'many',
    nested: { only: 'x' },
  },
  other: { scoped: { title: 'T' }, unusedToo: 'U' },
}

const SOURCE = `
import { useTranslation } from 'react-i18next'
export function A({ k, s, type }: { k: string; s: string; type: string }) {
  const { t } = useTranslation()
  const { t: tScoped } = useTranslation('other', { keyPrefix: 'scoped' })
  const labels = { labelKey: 'held' }
  return [t('used'), t(labels.labelKey), 'common:viaNs', t(\`surfaces.\${s}.label\`), t('jobs.types.' + type),
    t('group', { returnObjects: true }), t('items', { count: 2 }), tScoped('title'), k]
}
`

/** A fake repo root: the real i18n helper scripts, two locales, one source file. */
function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ts-locale-'))
  const fe = join(root, 'voc-datalake/frontend')
  mkdirSync(join(fe, 'scripts'), { recursive: true })
  for (const f of ['i18n-keys.mjs', 'i18n-locales.mjs']) copyFileSync(join(REPO_ROOT, 'voc-datalake/frontend/scripts', f), join(fe, 'scripts', f))
  symlinkSync(join(REPO_ROOT, 'voc-datalake/frontend/node_modules'), join(fe, 'node_modules'))
  mkdirSync(join(fe, 'src'), { recursive: true })
  writeFileSync(join(fe, 'src/A.tsx'), SOURCE)
  writeFileSync(join(fe, 'src/A.test.tsx'), "t('dead')\n")
  for (const lang of ['en', 'pl']) {
    mkdirSync(join(fe, 'public/locales', lang), { recursive: true })
    for (const [ns, data] of Object.entries(EN)) {
      const copy = lang === 'pl' && ns === 'common' ? { ...data, gone_few: 'kilka' } : data
      writeFileSync(join(fe, 'public/locales', lang, `${ns}.json`), `${JSON.stringify(copy, null, 2)}\n`)
    }
  }
  return root
}

test('reports only keys no t() call, literal, template, prefix, returnObjects or plural base reaches', async () => {
  const root = fakeRepo()
  try {
    const { unused, total } = await unusedKeys(root)
    assert.equal(total, 15)
    assert.deepEqual(unused.map(({ ns, key }) => `${ns}:${key}`).sort(),
      ['common:dead', 'common:gone_one', 'common:gone_other', 'common:nested.only', 'other:unusedToo'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--delete removes the keys in every locale, extra plural forms of a removed base, and empty parents', async () => {
  const root = fakeRepo()
  try {
    const { unused, helpers } = await unusedKeys(root)
    const removed = deleteKeys(root, unused, helpers)
    const pl = JSON.parse(readFileSync(join(root, 'voc-datalake/frontend/public/locales/pl/common.json'), 'utf8'))
    assert.equal(pl.gone_few, undefined)
    assert.equal(pl.nested, undefined)
    assert.equal(pl.dead, undefined)
    assert.equal(pl.used, 'Used')
    assert.equal(removed, 11) // en: 4 common + 1 other; pl: the same 5 + gone_few
    assert.ok(readFileSync(join(root, 'voc-datalake/frontend/public/locales/en/other.json'), 'utf8').endsWith('}\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isReached: dot-suffix literals need a dot; single-segment ancestors need returnObjects', () => {
  const m = { literals: new Set(['title', 'fields.name']), templates: [], prefixes: new Set() }
  assert.ok(isReached('ns', 'form.fields.name', m))
  assert.ok(!isReached('ns', 'form.title', m))
  assert.ok(!isReached('ns', 'title.sub', m))
})

test('deleteNested prunes emptied parents and reports misses', () => {
  const obj = { a: { b: { c: 1 } }, d: 2 }
  assert.ok(deleteNested(obj, 'a.b.c'))
  assert.deepEqual(obj, { d: 2 })
  assert.ok(!deleteNested(obj, 'x.y'))
})
