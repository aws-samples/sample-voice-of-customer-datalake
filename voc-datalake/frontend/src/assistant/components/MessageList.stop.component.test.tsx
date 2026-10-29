/**
 * The Stopped marker and Regenerate (5.35, E2E 5.34: a stopped answer looked like a finished one,
 * or vanished, and there was no way to ask again but to retype the question).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { createThreadState } from '../thread/reducer'
import MessageList from './MessageList'
import type { Message } from '@ag-ui/core'
import type { ThreadState } from '../thread/types'
import type { PageContext } from '../contract'

const PAGE: PageContext = { kind: 'home', path: '/' }

function threadWith(messages: Message[], extra: Partial<ThreadState> = {}): ThreadState {
  return { ...createThreadState('t1'), messages, ...extra }
}

const QUESTION: Message = { id: 'u1', role: 'user', content: 'Write a long report' }

describe('a stopped answer', () => {
  beforeEach(() => stubElementScrollIntoView())

  it('shows its partial text with a Stopped marker', () => {
    const thread = threadWith([QUESTION, { id: 'a1', role: 'assistant', content: 'The first theme is' }], { stopped: { a1: true } })
    render(<MessageList thread={thread} page={PAGE} />)
    expect(screen.getByText('The first theme is')).toBeInTheDocument()
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })

  it('shows the marker even when it was stopped before any text', () => {
    const thread = threadWith([QUESTION, { id: 'stopped-u1', role: 'assistant', content: '' }], { stopped: { 'stopped-u1': true } })
    render(<MessageList thread={thread} page={PAGE} />)
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })

  it('shows no marker on a finished answer', () => {
    render(<MessageList thread={threadWith([QUESTION, { id: 'a1', role: 'assistant', content: 'Done.' }])} page={PAGE} />)
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument()
  })
})

describe('Regenerate', () => {
  beforeEach(() => stubElementScrollIntoView())

  const twoTurns: Message[] = [
    QUESTION, { id: 'a1', role: 'assistant', content: 'First answer' },
    { id: 'u2', role: 'user', content: 'And the second?' }, { id: 'a2', role: 'assistant', content: 'Second answer' },
  ]

  it('is offered once, on the last answer, and answers the question again', async () => {
    const onRegenerate = vi.fn()
    render(<MessageList thread={threadWith(twoTurns)} page={PAGE} onRegenerate={onRegenerate} />)
    expect(screen.getAllByRole('button', { name: 'Regenerate' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })

  it('is offered on an answer stopped before any text', () => {
    const thread = threadWith([QUESTION, { id: 'stopped-u1', role: 'assistant', content: '' }], { stopped: { 'stopped-u1': true } })
    render(<MessageList thread={thread} page={PAGE} onRegenerate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument()
  })

  // 5.35.03 (e2e 5.35.02): a (regenerated) answer that ended on a tool call showed Copy only.
  const call = (id: string, name: string) => ({ id, type: 'function' as const, function: { name, arguments: '{}' } })
  const endsOnATool: Array<[string, Message[]]> = [
    ['an answer whose turn ends on a tool result', [
      QUESTION,
      { id: 'a1', role: 'assistant', content: 'Top themes', toolCalls: [call('nav', 'suggest_navigation')] },
      { id: 't1', role: 'tool', toolCallId: 'nav', content: '{"ok":true}' },
    ]],
    ['a turn ending on a tool-only message shown on an earlier one', [
      QUESTION,
      { id: 'a1', role: 'assistant', content: '', toolCalls: [call('c1', 'search_feedback')] },
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'r' },
      { id: 'a2', role: 'assistant', content: '', toolCalls: [call('c2', 'search_feedback')] },
      { id: 't2', role: 'tool', toolCallId: 'c2', content: 'r' },
    ]],
  ]
  it.each(endsOnATool)('is offered once on %s', (_case, messages) => {
    render(<MessageList thread={threadWith(messages)} page={PAGE} onRegenerate={vi.fn()} />)
    expect(screen.getAllByRole('button', { name: 'Regenerate' })).toHaveLength(1)
  })

  const busy: ThreadState['status'][] = ['streaming', 'awaiting_approval', 'generating']
  it.each(busy)('is not offered while the thread is %s', (status) => {
    render(<MessageList thread={threadWith(twoTurns, { status })} page={PAGE} onRegenerate={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument()
  })
})
