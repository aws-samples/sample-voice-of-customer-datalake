import { describe, expect, it } from 'vitest'
import {
  atLimit, documentLabel, documentMentionOptions, findTrigger, insertToken, mentionsForSend, personaMentionOptions, tokenOf,
} from './mentionModel'
import { defined } from '@test/defined'
import type { DocumentSource, MentionOption, MentionPick, PersonaSource } from './mentionModel'

const PERSONAS: PersonaSource[] = [
  { persona_id: 'p1', name: 'Deadline Dana' },
  { persona_id: 'p2', name: 'Value Victor' },
]
const DOCUMENTS: DocumentSource[] = [
  { document_id: 'old', document_type: 'prfaq', title: 'Delivery updates', version: 1, created_at: '2026-01-01T00:00:00Z' },
  { document_id: 'new', document_type: 'prfaq', title: 'Delivery updates (v2)', version: 2, created_at: '2026-03-01T00:00:00Z' },
  { document_id: 'proto', document_type: 'prototype', title: 'Checkout prototype', created_at: '2026-04-01T00:00:00Z' },
  { document_id: 'notes', document_type: 'custom', title: 'Interview notes', created_at: '2026-02-01T00:00:00Z' },
]

function pick(option: MentionOption | undefined): MentionPick {
  const known = defined(option, 'option')
  return { ...known, token: tokenOf(known) }
}

describe('findTrigger', () => {
  it.each([
    ['@', 1, { kind: 'persona', start: 0, query: '' }],
    ['ask @Dea', 8, { kind: 'persona', start: 4, query: 'Dea' }],
    ['review #Deli', 12, { kind: 'document', start: 7, query: 'Deli' }],
    ['line one\n#', 10, { kind: 'document', start: 9, query: '' }],
  ])('%j at %i is a mention being typed', (text, caret, expected) => {
    expect(findTrigger(text, caret)).toStrictEqual(expected)
  })

  it.each([
    ['mail me at a@b.com', 18],
    ['@Dana is here', 13],
    ['issue#12', 8],
    ['no trigger', 10],
  ])('%j at %i is ordinary text', (text, caret) => {
    expect(findTrigger(text, caret)).toBeNull()
  })
})

describe('options', () => {
  it('offers @all first, then the personas matching the query', () => {
    expect(personaMentionOptions(PERSONAS, '', [], 'Every persona').map((o) => o.label)).toStrictEqual(['Every persona', 'Deadline Dana', 'Value Victor'])
    expect(personaMentionOptions(PERSONAS, 'vic', [], 'Every persona').map((o) => o.label)).toStrictEqual(['Value Victor'])
  })

  it('hides @all once a single persona is picked, and hides picked personas', () => {
    const dana = pick(personaMentionOptions(PERSONAS, 'dana', [], 'x')[0])
    expect(personaMentionOptions(PERSONAS, '', [dana], 'Every persona').map((o) => o.label)).toStrictEqual(['Value Victor'])
  })

  it('lists text documents newest first with their version, never prototypes', () => {
    expect(documentMentionOptions(DOCUMENTS, '', []).map((o) => o.label)).toStrictEqual(['Delivery updates (v2)', 'Interview notes', 'Delivery updates (v1)'])
  })

  it('stops offering once a message has reached a limit', () => {
    const all = pick(personaMentionOptions(PERSONAS, 'all', [], 'Every persona')[0])
    const docs = documentMentionOptions(DOCUMENTS, '', []).map(pick)
    expect({ afterAll: atLimit('persona', [all]), threeDocs: atLimit('document', docs), twoDocs: atLimit('document', docs.slice(0, 2)) })
      .toStrictEqual({ afterAll: true, threeDocs: true, twoDocs: false })
  })
})

describe('documentLabel', () => {
  it.each([
    [{ title: 'Plan', version: 3 }, 'Plan (v3)'],
    [{ title: 'Plan (v3)', version: 3 }, 'Plan (v3)'],
    [{ title: 'Notes' }, 'Notes'],
  ])('%o → %s', (document, expected) => {
    expect(documentLabel(document)).toBe(expected)
  })
})

describe('insertToken', () => {
  it('replaces the typed query with the token and puts the caret after it', () => {
    const trigger = defined(findTrigger('ask @Dea now', 8) ?? undefined, 'trigger')
    expect(insertToken('ask @Dea now', trigger, 8, '@Deadline Dana')).toStrictEqual({ text: 'ask @Deadline Dana now', caret: 19 })
  })
})

describe('mentionsForSend', () => {
  const dana = pick(personaMentionOptions(PERSONAS, 'dana', [], 'x')[0])
  const v2 = pick(documentMentionOptions(DOCUMENTS, 'v2', [])[0])

  it('sends the picked ids, never names parsed from the text', () => {
    expect(mentionsForSend([dana, v2], '@Deadline Dana please review #Delivery updates (v2)')).toStrictEqual({
      personas: ['p1'], documents: [{ document_id: 'new', version: 2 }],
    })
  })

  it('drops a pick whose token was deleted from the text', () => {
    expect(mentionsForSend([dana, v2], 'please review #Delivery updates (v2)')).toStrictEqual({ documents: [{ document_id: 'new', version: 2 }] })
    expect(mentionsForSend([dana], 'nothing left')).toBeUndefined()
  })

  it('does not count a longer word as the token', () => {
    expect(mentionsForSend([dana], '@Deadline Danas')).toBeUndefined()
  })

  it('sends @all as the keyword', () => {
    const all = pick(personaMentionOptions(PERSONAS, '', [], 'Every persona')[0])
    expect(mentionsForSend([all], '@all thoughts?')).toStrictEqual({ personas: 'all' })
  })
})
