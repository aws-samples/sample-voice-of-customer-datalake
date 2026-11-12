/**
 * A comment or reply box from the keyboard: Ctrl/⌘+Enter sends the text, Escape closes a box with nothing in it and
 * leaves one with text open (the draft is kept); the box takes both keys (preventDefault), so what is around it (the
 * draft card, the focus view) does not act on them.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CommentComposer from './CommentComposer'

function renderComposer() {
  const onSubmit = vi.fn(() => Promise.resolve())
  const onCancel = vi.fn()
  render(<CommentComposer label="Reply" submitLabel="Send" onSubmit={onSubmit} onCancel={onCancel} />)
  return { onSubmit, onCancel, box: screen.getByRole('textbox', { name: 'Reply' }), user: userEvent.setup() }
}

describe('CommentComposer: the keyboard', () => {
  it.each([['Control'], ['Meta']])('sends the text on %s+Enter and empties the box', async (modifier) => {
    const { onSubmit, box, user } = renderComposer()
    await user.type(box, 'North first.')
    await user.keyboard(`{${modifier}>}{Enter}{/${modifier}}`)
    expect(onSubmit.mock.calls).toStrictEqual([['North first.']])
    expect(box).toHaveValue('')
  })

  it('names its shortcut for assistive technology', () => {
    expect(renderComposer().box).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')
  })

  it('keeps Enter alone for a new line', async () => {
    const { onSubmit, box, user } = renderComposer()
    await user.type(box, 'one{Enter}two')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(box).toHaveValue('one\ntwo')
  })

  it('closes an empty box on Escape, and takes the key', () => {
    const { onCancel, box } = renderComposer()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    box.dispatchEvent(event)
    expect({ cancelled: onCancel.mock.calls.length, taken: event.defaultPrevented }).toStrictEqual({ cancelled: 1, taken: true })
  })

  it('keeps a box with text open on Escape (its draft is not thrown away), and takes the key', async () => {
    const { onCancel, box, user } = renderComposer()
    await user.type(box, 'half a thought')
    const taken = !fireEvent.keyDown(box, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(taken).toBe(true)
    expect(box).toHaveValue('half a thought')
  })
})
