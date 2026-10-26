/** rebaseDraft: a fresh server copy never overwrites a field the user edited (3.00.00 R2). */
import { describe, expect, it } from 'vitest'
import { rebaseDraft } from './rebaseDraft'

interface Form { name: string; tags: string[]; note: string }
const KEYS = ['name', 'tags', 'note'] as const

describe('rebaseDraft', () => {
  const previous: Form = { name: 'Acme', tags: ['a'], note: '' }

  it('takes the new server value for every field the user did not touch', () => {
    const next: Form = { name: 'Acme Inc', tags: ['a', 'b'], note: 'x' }
    expect(rebaseDraft(previous, next, { ...previous }, KEYS)).toStrictEqual(next)
  })

  it('keeps every field the user edited, compared by value (arrays included)', () => {
    const next: Form = { name: 'Acme Inc', tags: ['z'], note: 'theirs' }
    const draft: Form = { name: 'Mine', tags: ['a', 'mine'], note: '' }
    expect(rebaseDraft(previous, next, draft, KEYS)).toStrictEqual({ name: 'Mine', tags: ['a', 'mine'], note: 'theirs' })
  })

  it('treats an equal-but-new array as untouched', () => {
    const next: Form = { ...previous, tags: ['server'] }
    expect(rebaseDraft(previous, next, { ...previous, tags: ['a'] }, KEYS).tags).toStrictEqual(['server'])
  })

  it('keeps fields outside `keys` from the new server copy', () => {
    const next: Form = { name: 'N', tags: [], note: 'n' }
    expect(rebaseDraft(previous, next, { name: 'Mine', tags: ['q'], note: 'q' }, ['name'])).toStrictEqual({ name: 'Mine', tags: [], note: 'n' })
  })
})
