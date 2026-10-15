/**
 * @fileoverview Tests for the chat composer's submit rule.
 *
 * The rule exists in one place because it previously did not: the button's
 * `disabled` and the submit handler each had their own copy, and Enter submits
 * the form without touching the button. So the case that matters most here is
 * "over-length input cannot be submitted", asserted through the single value both
 * call sites now read.
 *
 * @module pages/Chat/composerState.test
 */
import { describe, expect, it } from 'vitest'
import { MAX_CHAT_MESSAGE_LENGTH } from '../../api/streamLimits'
import { composerState } from './composerState'

describe('composerState', () => {
  it('allows a normal message', () => {
    expect(composerState('what are the urgent issues?', false)).toStrictEqual({
      isTooLong: false, canSubmit: true,
    })
  })

  it('refuses an empty message', () => {
    expect(composerState('', false).canSubmit).toBe(false)
  })

  it('refuses whitespace only', () => {
    expect(composerState('   \n  ', false).canSubmit).toBe(false)
  })

  it('refuses while a response is streaming', () => {
    expect(composerState('hello', true).canSubmit).toBe(false)
  })

  it('accepts input at exactly the cap', () => {
    const state = composerState('a'.repeat(MAX_CHAT_MESSAGE_LENGTH), false)
    expect(state.isTooLong).toBe(false)
    expect(state.canSubmit).toBe(true)
  })

  it('refuses input one character over the cap, and says why', () => {
    const state = composerState('a'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1), false)
    expect(state.isTooLong).toBe(true)
    expect(state.canSubmit).toBe(false)
  })

  it('accepts a pasted excerpt well under the cap', () => {
    // The cap this replaced was 2 000 chars, which refused normal pasted content.
    expect(composerState('a'.repeat(5_000), false).canSubmit).toBe(true)
  })

  it('does not report a short message as too long', () => {
    expect(composerState('hi', false).isTooLong).toBe(false)
  })
})
