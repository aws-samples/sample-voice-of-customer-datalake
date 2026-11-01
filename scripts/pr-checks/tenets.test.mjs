import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sections } from './markdown.mjs'
import { TENET_IDS, tenetsProblems, touchedIds } from './tenets.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const TENETS = readFileSync(join(ROOT, 'TENETS.md'), 'utf8')
const TEMPLATE = readFileSync(join(ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')
const problems = (text) => tenetsProblems(sections(`## Goal\n\nx\n\n${text}`))

test('TENET_IDS are exactly the tenets TENETS.md defines, in order', () => {
  const defined = [...TENETS.matchAll(/^### (D?\d+)\. /gm)].map((m) => m[1])
  assert.deepEqual(defined, [...TENET_IDS])
})

test('the TENETS.md checklist and the PR template both carry the Tenets section and line', () => {
  for (const [name, text] of [['TENETS.md', TENETS], ['PULL_REQUEST_TEMPLATE.md', TEMPLATE]]) {
    assert.match(text, /^## Tenets$/m, `${name} has a "## Tenets" heading`)
    assert.match(text, /^Tenets touched:/m, `${name} has a "Tenets touched:" line`)
  }
  assert.match(TEMPLATE, /TENETS\.md#pull-request-checklist/)
})

test('touchedIds reads numbers and D-ids in any case and separator', () => {
  assert.deepEqual(touchedIds('3, d1 and D4; 7'), ['3', 'D1', 'D4', '7'])
})

test('a section naming real tenets, or none, passes', () => {
  assert.deepEqual(problems('## Tenets\n\nTenets touched: 3, 7, D4'), [])
  assert.deepEqual(problems('## Tenets\n\nTenets touched: none'), [])
  assert.deepEqual(problems('## Tenets\n\n**Tenets touched:** None — docs only'), [])
})

test('a missing section, a missing or doubled line, an empty value or an unknown id fails', () => {
  assert.match(problems('## Release\n\n5.69.00 (minor)')[0], /missing section "## Tenets"/)
  assert.match(problems('## Tenets\n\nwe kept them')[0], /exactly one line/)
  assert.match(problems('## Tenets\n\nTenets touched: 1\n\nTenets touched: 2')[0], /exactly one line/)
  assert.match(problems('## Tenets\n\nTenets touched: <!-- e.g. 3 -->')[0], /names no tenet/)
  assert.match(problems('## Tenets\n\nTenets touched: 3, 8, D9')[0], /8, D9 is not a tenet/)
})

test('the untouched PR template fails the tenets check', () => {
  assert.equal(tenetsProblems(sections(TEMPLATE)).length, 1)
})
