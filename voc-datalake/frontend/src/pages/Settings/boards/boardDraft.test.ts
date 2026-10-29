/** The board editor's pure draft helpers: slugs, emails, status keys and order, field switches, problems. */
import { describe, expect, it } from 'vitest'
import { isValidSlug } from '../../../api/boardFields'
import {
  boardDraftProblems, moveStatus, parseEmails, sharePreview, slugFromName, statusKeyFor, toChanges, withFieldSetting,
} from './boardDraft'
import type { BoardDraft } from './boardDraft'

const NO_FIELDS = { request: {}, support: {} }

const draft = (over: Partial<BoardDraft> = {}): BoardDraft => ({
  name: 'Beta feedback', slug: 'beta-feedback', description: '', fields: NO_FIELDS,
  statuses: [{ key: 'new', label: 'New' }], mode: 'company', domains: [], emailsText: '', ...over,
})

describe('slugs', () => {
  it.each([
    ['Sales feature requests', 'sales-feature-requests'],
    ['  Café  & Co. 2026 ', 'cafe-co-2026'],
    ['ベータ', ''],
  ])('slugFromName(%s) = %s', (name, slug) => {
    expect(slugFromName(name)).toBe(slug)
  })

  it('caps a slug at 60 characters without a trailing dash', () => {
    const slug = slugFromName(`${'a'.repeat(59)} b`)
    expect([slug.length <= 60, slug.endsWith('-')]).toStrictEqual([true, false])
  })

  it('accepts only lower-case words joined by single dashes', () => {
    expect(['ok-slug', 'Bad', 'a--b', '-a', ''].map(isValidSlug)).toStrictEqual([true, false, false, false, false])
  })

  it('previews the share link on the board link origin', () => {
    expect(sharePreview('https://voc.example.com/board/old', 'new-one')).toBe('https://voc.example.com/board/new-one')
  })
})

describe('parseEmails', () => {
  it('lower-cases, de-duplicates and splits valid from invalid entries', () => {
    expect(parseEmails('A@acme.example, a@acme.example\nnot-an-email; b@example.com')).toStrictEqual({
      valid: ['a@acme.example', 'b@example.com'], invalid: ['not-an-email'],
    })
  })
})

describe('statuses', () => {
  it('derives a key from the label, unique among the taken ones', () => {
    expect([
      statusKeyFor('In progress', []), statusKeyFor('New', ['new']), statusKeyFor('完了', []),
      statusKeyFor('完了', ['status_a']),
    ]).toStrictEqual(['in_progress', 'new_a', 'status_a', 'status_b'])
  })

  it('moves a status up or down and leaves the ends in place', () => {
    const statuses = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]
    expect([moveStatus(statuses, 1, -1).map((s) => s.key), moveStatus(statuses, 0, -1).map((s) => s.key)])
      .toStrictEqual([['b', 'a'], ['a', 'b']])
  })
})

describe('withFieldSetting', () => {
  it('switches a field in its own level only and makes a switched-off field optional', () => {
    const request = { customer: { enabled: true, required: false } }
    const on = withFieldSetting({ request, support: {} }, 'support', 'customer', { enabled: true, required: true })
    expect([on, withFieldSetting(on, 'support', 'customer', { enabled: false })]).toStrictEqual([
      { request, support: { customer: { enabled: true, required: true } } },
      { request, support: { customer: { enabled: false, required: false } } },
    ])
  })
})

describe('boardDraftProblems', () => {
  it('needs a name, a valid slug and a labelled status', () => {
    expect(boardDraftProblems(draft({ name: ' ', slug: 'Bad', statuses: [{ key: 'new', label: '' }] })))
      .toStrictEqual(['nameRequired', 'slugInvalid', 'statusLabelRequired'])
  })

  it('needs a list audience to name someone, with valid emails only', () => {
    expect([
      boardDraftProblems(draft({ mode: 'list' })),
      boardDraftProblems(draft({ mode: 'list', emailsText: 'nope' })),
      boardDraftProblems(draft({ mode: 'list', domains: ['acme.example'] })),
    ]).toStrictEqual([['listEmpty'], ['emailsInvalid', 'listEmpty'], []])
  })

  it('refuses more than 500 emails', () => {
    const emailsText = Array.from({ length: 501 }, (_, i) => `p${String(i)}@example.com`).join('\n')
    expect(boardDraftProblems(draft({ mode: 'list', emailsText }))).toStrictEqual(['emailsTooMany'])
  })
})

describe('toChanges', () => {
  it('sends the trimmed configuration and drops the list for a non-list audience', () => {
    expect(toChanges(draft({ name: ' Beta ', mode: 'anyone', domains: ['acme.example'], emailsText: 'a@example.com' })))
      .toStrictEqual({
        name: 'Beta', slug: 'beta-feedback', description: '', fields: NO_FIELDS,
        statuses: [{ key: 'new', label: 'New' }], audience: { mode: 'anyone', domains: [], emails: [] },
      })
  })
})
