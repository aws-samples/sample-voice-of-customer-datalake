#!/usr/bin/env node

/**
 * Tests for the pure helpers of fix-i18n.mjs (fix-i18n-helpers.mjs).
 *
 * Pinned regressions from the first Polish run (5.16.00): Haiku 5.5 answers with a `thinking`
 * block before its `text` block (reading `content[0]` failed 68 batches), and Polish needs
 * `_few` / `_many` plural forms English has no key for.
 *
 * Run: node --test scripts/fix-i18n-helpers.test.mjs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  flattenEntries, isStringList, listItemOf, missingPluralForms, parseAnswer, resolveEnValue, selectedLanguages,
} from './fix-i18n-helpers.mjs'

describe('parseAnswer', () => {
  it('reads the text block when a thinking block comes first', () => {
    const resp = { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '{"save":"Zapisz"}' }] }
    assert.deepEqual(parseAnswer(resp), { save: 'Zapisz' })
  })

  it('strips markdown fences around the JSON', () => {
    assert.deepEqual(parseAnswer({ content: [{ type: 'text', text: '```json\n{"a":"b"}\n```' }] }), { a: 'b' })
  })

  it('throws naming the stop reason when there is no text block', () => {
    assert.throws(() => parseAnswer({ content: [{ type: 'thinking' }], stop_reason: 'max_tokens' }), /max_tokens/)
    assert.throws(() => parseAnswer({}), /no text block/)
  })
})

describe('missingPluralForms', () => {
  const en = { tree: { problems_one: '{{count}} problem', problems_other: '{{count}} problems' }, title: 'Problems' }
  const enEntries = flattenEntries(en)

  it('asks for the Polish few and many forms English does not have, from the English other text', () => {
    const pairs = missingPluralForms(en, enEntries, {}, 'pl')
    assert.deepEqual(pairs.sort(), [
      ['tree.problems_few', '{{count}} problems'],
      ['tree.problems_many', '{{count}} problems'],
    ])
  })

  it('skips forms the target already has and asks again for empty ones', () => {
    const target = { tree: { problems_few: '{{count}} problemy', problems_many: '' } }
    assert.deepEqual(missingPluralForms(en, enEntries, target, 'pl'), [['tree.problems_many', '{{count}} problems']])
  })

  it('asks for nothing in a language with no extra categories', () => {
    assert.deepEqual(missingPluralForms(en, enEntries, {}, 'ja'), [])
    assert.deepEqual(missingPluralForms(en, enEntries, {}, 'de'), [])
  })
})

describe('string lists', () => {
  it('recognises a non-empty list of strings only', () => {
    assert.equal(isStringList(['a', 'b']), true)
    assert.equal(isStringList([]), false)
    assert.equal(isStringList(['a', 1]), false)
    assert.equal(isStringList('a'), false)
  })

  it('matches an item key of a queued list, not a sibling with the same prefix', () => {
    const listKeys = [['responses.delivery', 2]]
    assert.equal(listItemOf('responses.delivery.0', listKeys), true)
    assert.equal(listItemOf('responses.delivery.10', listKeys), true)
    assert.equal(listItemOf('responses.deliveryNote', listKeys), false)
    assert.equal(listItemOf('responses.delivery.title', listKeys), false)
  })

  it('keeps a list as one leaf when flattening', () => {
    assert.deepEqual(flattenEntries({ r: { d: ['x', 'y'] } }), [['r.d', ['x', 'y']]])
  })
})

describe('selectedLanguages', () => {
  const known = ['es', 'pl']

  it('defaults to every known language', () => assert.deepEqual(selectedLanguages([], known), known))

  it('returns each --lang given, in order', () => {
    assert.deepEqual(selectedLanguages(['--lang', 'pl', '--lang', 'es'], known), ['pl', 'es'])
  })

  it('throws on an unknown code instead of translating nothing', () => {
    assert.throws(() => selectedLanguages(['--lang', 'xx'], known), /unknown --lang xx/)
  })
})

describe('resolveEnValue', () => {
  it('resolves a self-reference and leaves ordinary text alone', () => {
    const en = { sidebar: { messagesCount: '{{count}} messages' } }
    assert.equal(resolveEnValue(en, 'sidebar.messagesCount'), '{{count}} messages')
    assert.equal(resolveEnValue(en, 'Open the brief.'), 'Open the brief.')
  })
})
