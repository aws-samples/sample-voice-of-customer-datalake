/**
 * Which threads the comment margin shows: resolved ones only on request, by author kind, by
 * one persona; and the filter options offered (only what exists).
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_FILTER, authorKindsPresent, matchesFilter, personaOptions } from './commentFilters'
import type { CommentAuthor, CommentThread } from '../../api/documentReviewSchema'

function thread(id: string, author: CommentAuthor, status: CommentThread['status'] = 'open'): CommentThread {
  return {
    comment_id: id, document_id: 'doc_1', version: 1, text: 'A comment', anchor: null, status, flagged: false,
    created_at: '2026-10-28T00:00:00Z', author, replies: [], from_review_link: false,
  }
}

const TEAMMATE = thread('c1', { kind: 'user', name: 'Rui' })
const PRIYA = thread('c2', { kind: 'persona', name: 'Budget Priya', persona_id: 'p1' })
const OMAR = thread('c3', { kind: 'persona', name: 'Ops Omar', persona_id: 'p2' })
const REVIEWER = thread('c4', { kind: 'reviewer', name: 'sam@example.com' })
const RESOLVED = thread('c5', { kind: 'user', name: 'Rui' }, 'resolved')
const ALL = [TEAMMATE, PRIYA, OMAR, REVIEWER, RESOLVED]

const shown = (filter: typeof DEFAULT_FILTER) => ALL.filter((t) => matchesFilter(t, filter)).map((t) => t.comment_id)

describe('matchesFilter', () => {
  it('shows every open thread by default and hides resolved ones', () => {
    expect(shown(DEFAULT_FILTER)).toStrictEqual(['c1', 'c2', 'c3', 'c4'])
  })

  it('shows resolved threads when asked', () => {
    expect(shown({ ...DEFAULT_FILTER, showResolved: true })).toContain('c5')
  })

  it('narrows to one author kind', () => {
    expect([
      shown({ ...DEFAULT_FILTER, author: 'reviewer' }),
      shown({ ...DEFAULT_FILTER, author: 'persona' }),
    ]).toStrictEqual([['c4'], ['c2', 'c3']])
  })

  it('narrows personas to one persona when one is chosen', () => {
    expect(shown({ ...DEFAULT_FILTER, author: 'persona', personaId: 'p2' })).toStrictEqual(['c3'])
  })

  it('ignores a persona choice under another author kind', () => {
    expect(shown({ ...DEFAULT_FILTER, author: 'user', personaId: 'p2' })).toStrictEqual(['c1'])
  })
})

describe('the filter options', () => {
  it('lists each persona with threads once, in first-seen order', () => {
    expect(personaOptions([OMAR, PRIYA, OMAR, TEAMMATE])).toStrictEqual([
      { personaId: 'p2', name: 'Ops Omar' }, { personaId: 'p1', name: 'Budget Priya' },
    ])
  })

  it('offers only the author kinds present, in the fixed order', () => {
    expect([authorKindsPresent([REVIEWER, TEAMMATE]), authorKindsPresent([])]).toStrictEqual([['user', 'reviewer'], []])
  })
})
