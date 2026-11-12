/**
 * What a pass shows above the canvas, by outcome, keyboard and screen-reader complete: recommendations (each linked to
 * its thread; why nothing was written); the proposal as a list of labelled groups (before struck as "Removed", after
 * as "Added", the threads it answers, Accept / Reject named by the change; an out-of-date change cannot be accepted;
 * Accept all / Reject all; the status line is polite live text); the applied banner (Undo, Review again); the button
 * in the rail (the hint when no thread is answered yet, running, the failure).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ReviseButton from './ReviseButton'
import RevisePanel from './RevisePanel'
import type { RevisePass, RevisePassControls } from './useRevisePass'
import type { CommentThread, ReviseChange, ReviseFromCommentsResult } from '../../../api/documentReviewSchema'

const DRAFT = 'Quiet hours are 21:00 to 08:00.\n\nWe message at most once a day.\n'
const QUIET: ReviseChange = { change_id: 'ch_1', thread_ids: ['t1'], before: 'Quiet hours are 21:00 to 08:00', after: 'Quiet hours are 21:00 to 07:00', reason: 'Drivers start at 07:00.' }
const ONCE: ReviseChange = { change_id: 'ch_2', thread_ids: ['t2'], before: 'at most once a day', after: '', reason: '' }

const THREADS: CommentThread[] = [
  {
    comment_id: 't1', document_id: 'prd_3', version: 3, text: 'Too late for drivers', status: 'open', flagged: false, created_at: '',
    anchor: { exact: 'Quiet hours are 21:00 to 08:00', prefix: '', suffix: '', heading: '' }, author: { kind: 'user', name: 'Dana' },
    replies: [], from_review_link: false, addressed: null,
  },
]

function result(outcome: ReviseFromCommentsResult['outcome'], extra: Partial<ReviseFromCommentsResult> = {}): ReviseFromCommentsResult {
  return {
    outcome, base_document_id: 'prd_3', base_version: 3,
    recommendations: [{ thread_id: 't1', text: 'Move the end of quiet hours to 07:00.' }, { thread_id: 'gone', text: 'Name the report.' }],
    changes: [QUIET, ONCE], applied_version: null, addressed_thread_ids: [], dropped: 0, ...extra,
  }
}

function controlsFor(pass: RevisePass): RevisePassControls {
  return {
    pass, passed: true, holdsAccepted: false, start: vi.fn(() => Promise.resolve()), accept: vi.fn(), reject: vi.fn(), acceptAll: vi.fn(), rejectAll: vi.fn(),
    undo: vi.fn(() => Promise.resolve()), undoAnyway: vi.fn(() => Promise.resolve()), keepRevision: vi.fn(), close: vi.fn(),
  }
}

function renderPanel(pass: RevisePass, draft = DRAFT) {
  const controls = controlsFor(pass)
  const onShowThread = vi.fn<(threadId: string) => void>()
  const onReviewAgain = vi.fn()
  render(<RevisePanel controls={controls} draft={draft} threads={THREADS} onShowThread={onShowThread} onReviewAgain={onReviewAgain} canReview />)
  return { controls, onShowThread, onReviewAgain, user: userEvent.setup() }
}

const proposal = (extra: Partial<Extract<RevisePass, { kind: 'proposal' }>> = {}): RevisePass =>
  ({ kind: 'proposal', result: result('proposal'), decisions: {}, marked: null, ...extra })

describe('recommendations', () => {
  it('takes the focus on its heading, and says in its status that nothing was written, and why', () => {
    renderPanel({ kind: 'recommendations', result: result('recommendations', { changes: [] }) })

    const panel = screen.getByRole('region', { name: 'Recommendations from the comments' })
    expect(within(panel).getByRole('heading')).toHaveFocus()
    expect(within(panel).getByRole('status')).toHaveTextContent('2 recommendations. Nothing in the document was changed.')
    expect(panel).toHaveTextContent('Your way of working with AI asks for recommendations only')
  })

  it('lists one per thread, each linked to its thread (a deleted one says so)', async () => {
    const { onShowThread, user } = renderPanel({ kind: 'recommendations', result: result('recommendations', { changes: [] }) })

    const items = within(screen.getByRole('list', { name: 'Recommendations' })).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toStrictEqual([
      'Move the end of quiet hours to 07:00.Quiet hours are 21:00 to 08:00', 'Name the report.(comment deleted)',
    ])
    await user.click(screen.getByRole('button', { name: 'Show the comment: Quiet hours are 21:00 to 08:00' }))

    expect(onShowThread).toHaveBeenCalledWith('t1')
  })

  it('shows nothing while idle, running or failed (the button says those)', () => {
    for (const pass of [{ kind: 'idle' }, { kind: 'running' }, { kind: 'failed', message: null }] as const) {
      const { container } = render(<RevisePanel controls={controlsFor(pass)} draft={DRAFT} threads={THREADS} onShowThread={vi.fn()} onReviewAgain={vi.fn()} canReview />)
      expect(container).toBeEmptyDOMElement()
    }
  })
})

describe('the proposal', () => {
  it('is a list of labelled groups, one per change, under a polite status line', () => {
    renderPanel(proposal())

    const panel = screen.getByRole('region', { name: 'Suggested changes' })
    expect(within(panel).getByRole('status')).toHaveTextContent('2 changes suggested.')
    const groups = within(within(panel).getByRole('list', { name: 'Suggested changes' })).getAllByRole('group')
    expect(groups).toStrictEqual([screen.getByRole('group', { name: 'Change 1' }), screen.getByRole('group', { name: 'Change 2' })])
  })

  it('shows a change as removed and added text (said in words), why, and Accept / Reject named by the change', () => {
    renderPanel(proposal())

    const first = screen.getByRole('group', { name: 'Change 1' })
    expect({
      removed: first.querySelector('del')?.textContent, added: first.querySelector('ins')?.textContent,
      buttons: within(first).getAllByRole('button').map((button) => [button.getAttribute('aria-label'), button.hasAttribute('disabled')]),
    }).toStrictEqual({
      removed: 'Quiet hours are 21:00 to 08:00', added: 'Quiet hours are 21:00 to 07:00',
      buttons: [['Show the comment: Quiet hours are 21:00 to 08:00', false], ['Accept change 1', false], ['Reject change 1', false]],
    })
    expect(first).toHaveTextContent('Removed: Quiet hours are 21:00 to 08:00Added: Quiet hours are 21:00 to 07:00Drivers start at 07:00.')
    expect(screen.getByRole('group', { name: 'Change 2' })).toHaveTextContent('Added: (the passage is removed)')
  })

  it('accepts and rejects one change, or all of them', async () => {
    const { controls, user } = renderPanel(proposal())

    await user.click(screen.getByRole('button', { name: 'Accept change 1' }))
    await user.click(screen.getByRole('button', { name: 'Reject change 2' }))
    await user.click(screen.getByRole('button', { name: 'Accept all' }))
    await user.click(screen.getByRole('button', { name: 'Reject all' }))

    expect([controls.accept, controls.reject, controls.acceptAll, controls.rejectAll].map((fn) => vi.mocked(fn).mock.calls))
      .toStrictEqual([[['ch_1']], [['ch_2']], [[]], [[]]])
  })

  it('marks a change "out of date" when the draft no longer holds its passage, and it cannot be accepted', () => {
    renderPanel(proposal(), 'Quiet hours start at nine.\n\nWe message at most once a day.\n')

    const stale = screen.getByRole('group', { name: 'Change 1' })
    expect(stale).toHaveTextContent('Out of date: the passage has changed')
    expect(within(stale).getByRole('button', { name: 'Accept change 1' })).toBeDisabled()
    expect(within(stale).getByRole('button', { name: 'Reject change 1' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Accept change 2' })).toBeEnabled()
  })

  it('shows each decision, says to Save once one is accepted, and drops Accept all once nothing is left', () => {
    renderPanel(proposal({ decisions: { ch_1: 'accepted', ch_2: 'rejected' } }))

    expect([screen.getByRole('group', { name: 'Change 1' }), screen.getByRole('group', { name: 'Change 2' })].map((group) => group.dataset['changeState']))
      .toStrictEqual(['accepted', 'rejected'])
    expect(screen.getByRole('group', { name: 'Change 1' })).toHaveTextContent('Accepted')
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Accepted changes are in your draft. Save to make them a new version.')
  })

  it('says how many threads the save marked addressed, and in which version (or that it could not)', () => {
    renderPanel(proposal({ decisions: { ch_1: 'addressed' }, marked: { count: 1, version: 4 } }))
    expect(screen.getByRole('status')).toHaveTextContent('Saved: 1 comment is marked as addressed in v4.')
    expect(screen.getByRole('group', { name: 'Change 1' })).toHaveTextContent('Saved')
  })

  it('says when the save could not mark its threads', () => {
    renderPanel(proposal({ marked: 'failed' }))
    expect(screen.getByRole('status')).toHaveTextContent('Saved, but the comments could not be marked as addressed.')
  })

  it('with no change, shows the recommendations instead, and how many suggestions were left out', () => {
    renderPanel(proposal({ result: result('proposal', { changes: [], dropped: 2 }) }))

    expect(screen.getByText(/No change could be suggested/)).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Recommendations' })).toBeInTheDocument()
    expect(screen.getByText('2 suggestions were left out: their passages are not in the text.')).toBeInTheDocument()
  })

  it('closes', async () => {
    const { controls, user } = renderPanel(proposal())
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(controls.close).toHaveBeenCalledTimes(1)
  })

  it('keeps Close in the header\'s corner, out of the line that wraps (a phone wraps the title and actions only)', () => {
    renderPanel(proposal())
    const header = screen.getByTestId('revise-panel-header')
    const close = screen.getByRole('button', { name: 'Close' })
    const heading = screen.getByRole('heading', { name: 'Suggested changes' })
    expect({
      closeLast: header.lastElementChild === close, headerWraps: header.classList.contains('flex-wrap'),
      headingInWrappingLine: header.firstElementChild?.contains(heading) === true && header.firstElementChild.classList.contains('flex-wrap'),
    }).toStrictEqual({ closeLast: true, headerWraps: false, headingInWrappingLine: true })
  })
})

describe('the applied banner', () => {
  const applied = (undo: Extract<RevisePass, { kind: 'applied' }>['undo'], newer?: number): RevisePass => ({
    kind: 'applied', undo, ...(newer === undefined ? {} : { newer }), result: result('applied', { applied_version: { document_id: 'prd_4', version: 4 }, addressed_thread_ids: ['t1', 't2'] }),
  })

  it('says how many comments revised which version, with Undo and Review again', async () => {
    const { controls, onReviewAgain, user } = renderPanel(applied('idle'))

    expect(screen.getByRole('region', { name: 'Revised from 2 comments as v4' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await user.click(screen.getByRole('button', { name: 'Review again' }))

    expect(controls.undo).toHaveBeenCalledTimes(1)
    expect(onReviewAgain).toHaveBeenCalledTimes(1)
  })

  it('counts the comments its changes answer (each once), even when marking them addressed failed', () => {
    const twice: ReviseChange = { ...ONCE, change_id: 'ch_3', thread_ids: ['t1', 't2'] }
    renderPanel({
      kind: 'applied', undo: 'idle',
      result: result('applied', { changes: [QUIET, ONCE, twice], applied_version: { document_id: 'prd_4', version: 4 }, addressed_thread_ids: [] }),
    })

    expect(screen.getByRole('region', { name: 'Revised from 2 comments as v4' })).toBeInTheDocument()
  })

  it('says the undo is running, done (no second Undo) or failed', () => {
    const { unmount } = render(<RevisePanel controls={controlsFor(applied('running'))} draft={DRAFT} threads={THREADS} onShowThread={vi.fn()} onReviewAgain={vi.fn()} canReview />)
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Restoring the previous version…')
    unmount()

    renderPanel(applied('done'))
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Undone: the previous version is restored as a new version.')
  })

  it('when a version was saved since, says so and offers Undo anyway / Keep it (focused), not Undo', async () => {
    const controls = controlsFor(applied('confirm', 5))
    const panel = (pass: RevisePass) => (
      <RevisePanel controls={{ ...controls, pass }} draft={DRAFT} threads={THREADS} onShowThread={vi.fn()} onReviewAgain={vi.fn()} canReview />
    )
    const { rerender } = render(panel(applied('running')))
    rerender(panel(applied('confirm', 5)))
    const user = userEvent.setup()

    expect(screen.getByRole('status')).toHaveTextContent('v5 was saved after this revision.')
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Undo anyway' }))
    await user.click(screen.getByRole('button', { name: 'Keep it' }))

    expect([controls.undoAnyway, controls.keepRevision, controls.undo].map((spy) => vi.mocked(spy).mock.calls.length))
      .toStrictEqual([1, 1, 0])
  })

  it('points to History when the undo failed', () => {
    renderPanel(applied('failed'))
    expect(screen.getByRole('status')).toHaveTextContent('Restore it from History.')
  })
})

describe('the button', () => {
  it('starts a pass when a thread is answered', async () => {
    const onStart = vi.fn()
    render(<ReviseButton pass={{ kind: 'idle' }} available={2} onStart={onStart} />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Revise from comments' }))

    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it.each([
    { when: 'no thread is answered yet', available: 0, unsaved: false, reason: 'Reply to a comment or resolve it first.' },
    { when: 'accepted changes wait for their save', available: 2, unsaved: true, reason: 'Save or discard the accepted changes first.' },
  ])('is disabled with the reason, when $when', ({ available, unsaved, reason }) => {
    render(<ReviseButton pass={{ kind: 'idle' }} available={available} unsaved={unsaved} onStart={vi.fn()} />)

    const button = screen.getByRole('button', { name: 'Revise from comments' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(reason)
  })

  it('says it is running, and a failure (the server\'s reason, else a generic one)', () => {
    const { rerender } = render(<ReviseButton pass={{ kind: 'running' }} available={1} onStart={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Revising from comments…' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Revising from comments…')

    rerender(<ReviseButton pass={{ kind: 'failed', message: 'This version is stale' }} available={1} onStart={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('This version is stale')
    rerender(<ReviseButton pass={{ kind: 'failed', message: null }} available={1} onStart={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Revise from comments failed. Please try again.')
  })
})
