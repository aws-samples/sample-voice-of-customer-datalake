import { describe, expect, it } from 'vitest'
import { personLabel, publicPersonLabel } from './sharingHelpers'

const UUID = 'aff8498b-61ed-4c35-b5eb-300a1e9e2bdf'

describe('personLabel', () => {
  it.each([
    ['the name first', { name: 'Pat Doe', username: 'pat', email: 'pat@example.com', sub: 's1' }, 'Pat Doe'],
    ['a human username without a name', { username: 'pat', email: 'pat@example.com', sub: 's1' }, 'pat'],
    ['the email instead of a UUID username', { username: UUID, email: 'pat@example.com', sub: 's1' }, 'pat@example.com'],
    ['the email instead of a username that is the sub', { username: 's1', email: 'pat@example.com', sub: 's1' }, 'pat@example.com'],
    ['the sub only when nothing else exists', { username: '', email: '', sub: 's1' }, 's1'],
  ])('uses %s', (_case, person, label) => {
    expect(personLabel(person)).toBe(label)
  })
})

describe('publicPersonLabel', () => {
  it('never shows the email, even when the username is a UUID', () => {
    expect(publicPersonLabel({ username: UUID, sub: UUID })).toBe(UUID)
    expect(publicPersonLabel({ username: UUID, sub: UUID, name: 'Pat Doe' })).toBe('Pat Doe')
  })
})
