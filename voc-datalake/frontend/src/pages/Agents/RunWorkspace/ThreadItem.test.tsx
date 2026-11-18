/**
 * @fileoverview One item of an agent's thread (7.54.00): a long reply opens folded behind "Show more", the agent's
 * thinking is a folded "Thinking…" row with its first words, and a call its ended session never answered does not
 * spin. Rendered alone: the workspace's own suite (RunWorkspace.test.tsx) reads them in a whole thread.
 */
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient as render } from '@test/query-client'
import { LONG_TEXT_CHARS } from './threadModel'
import { ThreadItemView } from './ThreadItem'
import type { ThreadItem } from '../../../api/engineeringRunWorkspaceApi'

const item = (overrides: Partial<ThreadItem>): ThreadItem => ({
  ref: '1.2.3', at: '2026-11-18T18:30:25Z', kind: 'said', from: { kind: 'agent', id: 'hunter-4' }, text: 'x', cut: false,
  update: 'agent_message_chunk', tool: null, ...overrides,
})

const show = (entry: ThreadItem, ended = false) =>
  render(<ol><ThreadItemView runId="RUN1" agent="hunter-4" item={entry} header ended={ended} /></ol>)

describe('a reply', () => {
  it('opens a long one folded behind "Show more", and shows it whole after', async () => {
    show(item({ text: `I confirmed one bug. ${'The divide drops the fraction. '.repeat(LONG_TEXT_CHARS / 20)}` }))
    const more = screen.getByRole('button', { name: 'Show more' })
    const region = document.getElementById(more.getAttribute('aria-controls') ?? '')
    expect([more.getAttribute('aria-expanded'), region?.dataset.folded]).toStrictEqual(['false', 'true'])
    await userEvent.click(more)
    expect([screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded'), region?.dataset.folded]).toStrictEqual(['true', 'false'])
  })

  it('shows a short one whole, under who said it, with nothing to unfold', () => {
    show(item({ text: 'Confirmed; pytest is not installed.' }))
    expect(screen.getByText('Confirmed; pytest is not installed.')).toBeVisible()
    expect(screen.getByText('hunter-4')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
  })
})

describe('the thinking and an unanswered call', () => {
  it('folds the thinking under "Thinking…" with its first words beside it', () => {
    show(item({ kind: 'thought', text: 'The slice end adds one.\nSo the last page has one more.', update: 'agent_thought_chunk' }))
    const row = screen.getByText('Thinking…').closest('details')
    expect([row?.open, row?.querySelector('summary')?.textContent]).toStrictEqual([false, 'Thinking…The slice end adds one.'])
  })

  it('says a call its ended session never answered got no result, and spins only while the session lives', () => {
    const call = item({ kind: 'tool', text: '', update: 'tool_call', tool: { name: 'wait_for_agents', ok: null, input: '{}', kind: 'other', status: 'in_progress' } })
    const { unmount } = show(call, true)
    expect(screen.getByLabelText('No result: the session ended first')).not.toHaveClass('animate-spin')
    unmount()
    show(call)
    expect(screen.getByLabelText('Running')).toHaveClass('animate-spin')
  })
})
