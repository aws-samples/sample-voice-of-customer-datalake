/**
 * The comment filters' look and names: the author and persona filters are the design system's `select` (its theme
 * chevron and control edge, not a text field's), each named for assistive technology.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import enComponents from '../../../public/locales/en/components.json'
import CommentFiltersBar from './CommentFiltersBar'
import type { CommentThread } from '../../api/documentReviewSchema'

const text = enComponents.documentComments

function thread(id: string, author: CommentThread['author']): CommentThread {
  return {
    comment_id: id, document_id: 'doc_1', version: 1, text: id, status: 'open', flagged: false, anchor: null,
    created_at: '2026-10-28T10:00:00Z', author, replies: [], from_review_link: false, addressed: null,
  }
}

describe('CommentFiltersBar', () => {
  it('draws the author and persona filters as named selects', () => {
    const threads = [
      thread('a', { kind: 'user', name: 'Ada' }),
      thread('b', { kind: 'persona', name: 'Ben', persona_id: 'p1' }),
      thread('c', { kind: 'persona', name: 'Cy', persona_id: 'p2' }),
    ]
    render(<CommentFiltersBar threads={threads} onFilterChange={vi.fn()}
      filter={{ author: 'persona', personaId: '', showResolved: false, addressedOnly: false }} />)
    const looks = [text.filterAuthor, text.filterPersona].map((name) => {
      const select = screen.getByRole('combobox', { name })
      return { select: select.classList.contains('select'), field: select.classList.contains('input') }
    })
    expect(looks).toStrictEqual([{ select: true, field: false }, { select: true, field: false }])
  })
})
