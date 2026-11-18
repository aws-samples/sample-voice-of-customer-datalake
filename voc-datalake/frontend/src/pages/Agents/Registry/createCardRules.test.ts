/**
 * Registry → Create from a skill, the form's rules (createCardRules.ts): what to fix first, by field (a role offered,
 * an accepted version, the slug's shape, the title and the purpose as one line of plain text within their bounds, each
 * cap a whole number at most the template's), and the body the server takes (only the caps typed, the title only when
 * given, the scope only for a connection).
 */
import { describe, it, expect } from 'vitest'
import { madeCardId, cardIssues, createCardBody } from './createCardRules'
import type { CardForm } from './createCardRules'

const ROLES = ['fixer', 'hunter']
const CAPS = { max_turns: 150, max_input_tokens: 120_000 }
const form = (fields: Partial<CardForm> = {}): CardForm => ({
  role: 'fixer', connection: '', version: 3, slug: 'careful', title: '', purpose: 'The fixer, held to fewer turns.', caps: {}, ...fields,
})

describe('Create from a skill: what to fix first', () => {
  it('lets a complete form through', () => {
    expect(cardIssues(form(), ROLES, CAPS)).toStrictEqual([])
  })

  it('names a role not offered, no version, and a slug missing or off its shape', () => {
    expect(cardIssues(form({ role: 'coach', version: null, slug: '' }), ROLES, CAPS)).toStrictEqual([
      { field: 'role', issue: 'role' }, { field: 'version', issue: 'version' }, { field: 'slug', issue: 'slugMissing' }])
    expect(['-careful', 'Careful', 'a'.repeat(41), 'care ful'].map((slug) => cardIssues(form({ slug }), ROLES, CAPS)))
      .toStrictEqual(Array.from({ length: 4 }, () => [{ field: 'slug', issue: 'slugShape' }]))
  })

  it('holds the title and the purpose to one line of plain text within their bounds', () => {
    expect(cardIssues(form({ title: 'x'.repeat(81), purpose: ' ' }), ROLES, CAPS)).toStrictEqual([
      { field: 'title', issue: 'titleLong' }, { field: 'purpose', issue: 'purposeMissing' }])
    expect(cardIssues(form({ title: 'Two\nlines', purpose: 'p'.repeat(301) }), ROLES, CAPS)).toStrictEqual([
      { field: 'title', issue: 'titleText' }, { field: 'purpose', issue: 'purposeLong' }])
  })

  it('holds each cap typed to a whole number above 0 and at most the template\'s, and leaves an empty one alone', () => {
    expect(cardIssues(form({ caps: { max_turns: '200', max_input_tokens: '1.5' } }), ROLES, CAPS)).toStrictEqual([
      { field: 'cap:max_turns', issue: 'capOver' }, { field: 'cap:max_input_tokens', issue: 'capShape' }])
    expect(cardIssues(form({ caps: { max_turns: ' ', max_input_tokens: '0' } }), ROLES, CAPS))
      .toStrictEqual([{ field: 'cap:max_input_tokens', issue: 'capShape' }])
  })
})

describe('Create from a skill: the body', () => {
  it('sends the skill version, the slug and the purpose, and the caps typed only', () => {
    expect(createCardBody(form({ caps: { max_turns: ' 80 ', max_input_tokens: '' } }))).toStrictEqual({
      from_skill: { role: 'fixer', version: 3 }, slug: 'careful', purpose: 'The fixer, held to fewer turns.', caps: { max_turns: 80 } })
  })

  it('names a connection\'s scope and the title only when given', () => {
    expect(createCardBody(form({ connection: 'storefront', title: ' Careful fixer ' }))).toStrictEqual({
      from_skill: { role: 'fixer', connection: 'storefront', version: 3 }, slug: 'careful', purpose: 'The fixer, held to fewer turns.',
      title: 'Careful fixer' })
    expect(madeCardId('fixer', ' careful ')).toBe('fixer-careful')
  })
})
