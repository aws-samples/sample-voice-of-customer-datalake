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
  flattenEntries, isStringList, keySelected, listItemOf, missingPluralForms, parseAnswer, parseOptions, resolveEnValue,
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

describe('parseOptions', () => {
  const known = { languages: ['es', 'pl'], namespaces: ['login', 'participants'] }

  it('defaults to every language and namespace, every key, and the delta only', () => {
    assert.deepEqual(parseOptions([], known),
      { languages: ['es', 'pl'], namespaces: ['login', 'participants'], keys: null, recheckEnglish: false })
  })

  it('returns each --lang / --ns given, in order, repeated or comma-separated', () => {
    const options = parseOptions(['--lang', 'pl', '--lang', 'es', '--ns', 'participants,login'], known)
    assert.deepEqual([options.languages, options.namespaces], [['pl', 'es'], ['participants', 'login']])
  })

  it('takes --keys and --recheck-english', () => {
    const options = parseOptions(['--keys', 'errors.senderDailyCap, passkey.add', '--recheck-english'], known)
    assert.deepEqual([options.keys, options.recheckEnglish], [['errors.senderDailyCap', 'passkey.add'], true])
  })

  it('throws on an unknown language or namespace instead of translating nothing', () => {
    assert.throws(() => parseOptions(['--lang', 'xx'], known), /unknown --lang xx/)
    assert.throws(() => parseOptions(['--ns', 'nope'], known), /unknown --ns nope/)
  })
})

describe('keySelected', () => {
  it('selects every key without --keys', () => assert.equal(keySelected('a.b', null), true))

  it('selects the key, its plural forms and its list items or subkeys, nothing else', () => {
    const keys = ['errors.count', 'passkey']
    assert.deepEqual(
      ['errors.count', 'errors.count_few', 'errors.count.0', 'passkey.offer.title', 'errors.counted', 'errors.count_x', 'other']
        .map((key) => keySelected(key, keys)),
      [true, true, true, true, false, false, false],
    )
  })
})

describe('resolveEnValue', () => {
  it('resolves a self-reference and leaves ordinary text alone', () => {
    const en = { sidebar: { messagesCount: '{{count}} messages' } }
    assert.equal(resolveEnValue(en, 'sidebar.messagesCount'), '{{count}} messages')
    assert.equal(resolveEnValue(en, 'Open the brief.'), 'Open the brief.')
  })
})
