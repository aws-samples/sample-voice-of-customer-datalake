/**
 * One thread card in the comments margin: a resolved thread recedes through its surface, never
 * through opacity (its author, time, badge and quote keep AA contrast), and a long author name is
 * never cut short in the narrow margin.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import CommentThreadCard from './CommentThreadCard'
import type { CommentThread } from '../../api/documentReviewSchema'

const LONG_NAME = 'administrator.of.the.workspace@example.com'

const THREAD: CommentThread = {
  comment_id: 'c1', document_id: 'doc_1', version: 1, text: 'Which method?', status: 'open', flagged: false,
  anchor: { exact: 'two weeks', prefix: 'wait ', suffix: ' for', heading: '' },
  created_at: '2026-10-28T10:00:00Z', author: { kind: 'user', name: LONG_NAME }, replies: [], from_review_link: false,
}

function renderCard(thread: CommentThread) {
  render(<CommentThreadCard thread={thread} viewed={{ documentId: 'doc_1' }} active={false} onActivate={vi.fn()}
    actions={{ create: () => Promise.resolve(), reply: () => Promise.resolve() }} />)
  return screen.getByRole('article', { name: `Comment by ${LONG_NAME}` })
}

/** The card and everything in it: no element is dimmed with an opacity utility. */
const dimmed = (card: HTMLElement) => [card, ...card.querySelectorAll<HTMLElement>('*')].filter((el) => /(^|\s)opacity-/.test(el.className))

describe('CommentThreadCard', () => {
  it('shows a resolved thread without lowering its contrast: a quieter surface and the Resolved badge', () => {
    const card = renderCard({ ...THREAD, status: 'resolved' })

    expect(dimmed(card)).toStrictEqual([])
    expect(card).toHaveClass('bg-bg-accent', 'border-dashed')
    expect(screen.getByText('Resolved')).toBeVisible()
  })

  it('shows an open thread on the card surface, undimmed', () => {
    const card = renderCard(THREAD)

    expect(dimmed(card)).toStrictEqual([])
    expect(card).toHaveClass('bg-card')
    expect(card).not.toHaveClass('border-dashed')
  })

  it('never truncates the author name: it wraps, the kind and time move under it', () => {
    renderCard(THREAD)

    const name = screen.getByText(LONG_NAME)
    expect(name).not.toHaveClass('truncate')
    expect(name.parentElement).toHaveClass('flex-wrap')
  })
})
