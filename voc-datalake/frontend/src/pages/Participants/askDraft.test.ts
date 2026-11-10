/**
 * @fileoverview The composer's draft rules, the recipient count and the person-field checks.
 */
import { describe, expect, it } from 'vitest'
import { countRecipients, draftIssues, emptyDraft, toAskInput, toggle } from './askDraft'
import { isPlausibleDomain, isPlausibleEmail, parseTags } from './participantInput'

const ready = { ...emptyDraft(['lst_1']), subject: 'Hi', message: 'Tell us', formId: 'form_1' }

describe('the ask draft', () => {
  it('a complete draft has no issues', () => {
    expect(draftIssues(ready, 3)).toStrictEqual([])
  })

  it('an empty draft names every missing part, in field order', () => {
    expect(draftIssues(emptyDraft(), 0)).toStrictEqual(['noRecipients', 'subjectMissing', 'messageMissing', 'formMissing'])
  })

  it('refuses more than 500 recipients, but not while still counting', () => {
    expect(draftIssues(ready, 501)).toStrictEqual(['tooManyRecipients'])
    expect(draftIssues(ready, null)).toStrictEqual([])
  })

  it('refuses a subject or message over the route bounds', () => {
    expect(draftIssues({ ...ready, subject: 'x'.repeat(161), message: 'y'.repeat(4001) }, 1)).toStrictEqual(['subjectTooLong', 'messageTooLong'])
  })

  it('accepts only an https link when the link is a web page', () => {
    expect(draftIssues({ ...ready, linkKind: 'url', url: 'http://example.com' }, 1)).toStrictEqual(['urlNotHttps'])
    expect(draftIssues({ ...ready, linkKind: 'url', url: 'https://example.com/survey' }, 1)).toStrictEqual([])
    expect(draftIssues({ ...ready, linkKind: 'url', url: 'not a url' }, 1)).toStrictEqual(['urlNotHttps'])
  })

  it('becomes the route body, with the project only when there is one', () => {
    expect(toAskInput(ready, '')).toStrictEqual({
      list_ids: ['lst_1'], person_ids: [], subject: 'Hi', message: 'Tell us', link: { kind: 'form', form_id: 'form_1' },
    })
    expect(toAskInput({ ...ready, linkKind: 'url', url: ' https://example.com ' }, 'proj_1')).toMatchObject({
      project_id: 'proj_1', link: { kind: 'url', url: 'https://example.com' },
    })
  })

  it('counts each person once across lists and individual picks', () => {
    expect(countRecipients([['a', 'b'], ['b', 'c']], ['c', 'd'])).toBe(4)
  })

  it('toggles an id in and out of a selection', () => {
    expect(toggle(['a'], 'b')).toStrictEqual(['a', 'b'])
    expect(toggle(['a', 'b'], 'a')).toStrictEqual(['b'])
  })
})

describe('person field checks', () => {
  it('accepts a plain address and refuses malformed ones', () => {
    expect(isPlausibleEmail(' ana@example.com ')).toBe(true)
    for (const bad of ['ana', 'ana@', '@example.com', 'a@b@example.com', 'ana lopez@example.com', 'ana@example']) {
      expect(isPlausibleEmail(bad)).toBe(false)
    }
  })

  it('accepts dotted domains and refuses empty labels or stray characters', () => {
    expect(isPlausibleDomain('mail.acme.example')).toBe(true)
    for (const bad of ['example', 'example..com', '-acme.example', 'acme_.example', 'ex ample.com']) expect(isPlausibleDomain(bad)).toBe(false)
  })

  it('reads tags from a comma-separated line, trimmed and de-duplicated', () => {
    expect(parseTags(' beta, crew ,beta,, ')).toStrictEqual(['beta', 'crew'])
  })
})
